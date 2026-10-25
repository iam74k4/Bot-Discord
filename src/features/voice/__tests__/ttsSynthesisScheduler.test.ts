import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { SynthesisScheduler } = await import('../tts/synthesisScheduler.js');
const { logger } = await import('../../../shared/utils/logger.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/**
 * A fake engine: every job is a request that finishes only when the test
 * says so. `started` lists the requests in the order the engine got them.
 */
function engine() {
  const requests = new Map<string, Deferred<string>>();
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const render = (name: string) => async () => {
    started.push(name);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const request = deferred<string>();
    requests.set(name, request);
    try {
      return await request.promise;
    } finally {
      inFlight--;
    }
  };

  return {
    render,
    started,
    finish: (name: string) => requests.get(name)!.resolve(name),
    fail: (name: string, error: Error) => requests.get(name)!.reject(error),
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

describe('SynthesisScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends the engine one request at a time', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const jobs = ['a1', 'a2', 'a3'].map((name) =>
      scheduler.submit('a', e.render(name))
    );
    await flush();
    expect(e.started).toEqual(['a1']);
    expect(scheduler.running).toBe(1);
    expect(scheduler.waiting).toBe(2);

    e.finish('a1');
    await expect(jobs[0].promise).resolves.toBe('a1');
    await flush();
    expect(e.started).toEqual(['a1', 'a2']);

    e.finish('a2');
    await flush();
    e.finish('a3');
    await expect(jobs[2].promise).resolves.toBe('a3');
    expect(e.maxInFlight).toBe(1);
  });

  it('honours a higher concurrency', async () => {
    const scheduler = new SynthesisScheduler({ concurrency: 2 });
    const e = engine();

    for (const name of ['a1', 'a2', 'a3']) {
      scheduler.submit('a', e.render(name));
    }
    await flush();

    expect(e.started).toEqual(['a1', 'a2']);
  });

  it('keeps submission order within a key', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    for (const name of ['a1', 'a2', 'a3']) {
      scheduler.submit('a', e.render(name));
    }
    for (const name of ['a1', 'a2', 'a3']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['a1', 'a2', 'a3']);
  });

  it('lets sessions take turns: a burst in one cannot starve another', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    for (const name of ['a1', 'a2', 'a3']) {
      scheduler.submit('a', e.render(name));
    }
    scheduler.submit('b', e.render('b1'));

    for (const name of ['a1', 'b1', 'a2', 'a3']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('puts a job submitted after another right behind it, ahead of later ones', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const line1 = scheduler.submit('a', e.render('line1'));
    scheduler.submit('a', e.render('line2'));
    await flush();
    // line1 is running: its continuation goes to the front of the queue...
    const slice2 = scheduler.submit('a', e.render('line1-s2'), {
      after: line1,
    });
    // ...and the next continuation right behind that one.
    scheduler.submit('a', e.render('line1-s3'), { after: slice2 });

    for (const name of ['line1', 'line1-s2', 'line1-s3', 'line2']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['line1', 'line1-s2', 'line1-s3', 'line2']);
  });

  it('serves a waiting session before the rest of a line already being rendered', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const line = scheduler.submit('a', e.render('a-s1'));
    await flush();
    scheduler.submit('b', e.render('b1'));
    // The rest of a's line arrives while its first slice renders: b has not
    // had a turn yet, so it goes first; a's slice waits one request.
    scheduler.submit('a', e.render('a-s2'), { after: line });

    for (const name of ['a-s1', 'b1', 'a-s2']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['a-s1', 'b1', 'a-s2']);
  });

  it('takes turns per line: the rest of a line never waits on more than one other request', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const a1 = scheduler.submit('a', e.render('a1-s1'));
    scheduler.submit('a', e.render('a2'));
    await flush();
    for (const name of ['b1', 'b2']) scheduler.submit('b', e.render(name));
    // a1's query has answered: its other slices queue behind its first.
    const s2 = scheduler.submit('a', e.render('a1-s2'), { after: a1 });
    scheduler.submit('a', e.render('a1-s3'), { after: s2 });

    for (const name of ['a1-s1', 'b1', 'a1-s2', 'a1-s3', 'a2', 'b2']) {
      await flush();
      e.finish(name);
    }
    await flush();

    // b goes once between a1's first slice and the rest, and then a1
    // finishes: lines start a1, b1, a2, b2, and a1 pauses once, not per
    // slice (a1-s1, b1, a1-s2, b2, a1-s3, a2).
    expect(e.started).toEqual(['a1-s1', 'b1', 'a1-s2', 'a1-s3', 'a2', 'b2']);
  });

  it('gives a session that went quiet the next turn', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    scheduler.submit('b', e.render('b1'));
    await flush();
    e.finish('b1');
    await flush();
    for (const name of ['a1', 'a2']) scheduler.submit('a', e.render(name));
    await flush();
    scheduler.submit('b', e.render('b2'));

    for (const name of ['a1', 'b2', 'a2']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['b1', 'a1', 'b2', 'a2']);
  });

  it('never sends a job cancelled while it waits', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    scheduler.submit('a', e.render('a1'));
    const dropped = scheduler.submit('a', e.render('a2'));
    scheduler.submit('a', e.render('a3'));
    await flush();

    dropped.cancel();
    await expect(dropped.promise).resolves.toBeNull();
    expect(dropped.state).toBe('done');

    e.finish('a1');
    await flush();
    e.finish('a3');
    await flush();
    expect(e.started).toEqual(['a1', 'a3']);
  });

  it('cancelling the only waiting job of a session leaves the others turning', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    scheduler.submit('a', e.render('a1'));
    scheduler.submit('b', e.render('b1')).cancel();
    scheduler.submit('c', e.render('c1'));
    await flush();
    e.finish('a1');
    await flush();

    expect(e.started).toEqual(['a1', 'c1']);
    expect(scheduler.waiting).toBe(0);
  });

  it('drops the result of a running job at once but keeps its slot until the engine is done', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const running = scheduler.submit('a', e.render('a1'));
    scheduler.submit('b', e.render('b1'));
    await flush();
    expect(e.started).toEqual(['a1']);

    running.cancel();
    await expect(running.promise).resolves.toBeNull();
    await flush();
    // The engine is still busy with a1: b1 must not pile up behind it.
    expect(e.started).toEqual(['a1']);

    e.finish('a1');
    await flush();
    expect(e.started).toEqual(['a1', 'b1']);
  });

  it('tells a running job it was cancelled, so it can stop between requests', async () => {
    const scheduler = new SynthesisScheduler();
    const between = deferred<void>();
    let secondRequest = false;

    const job = scheduler.submit('a', async (token) => {
      await between.promise;
      if (token.cancelled) return null;
      secondRequest = true;
      return 'done';
    });
    await flush();

    job.cancel();
    between.resolve();
    await flush();

    expect(secondRequest).toBe(false);
    expect(scheduler.running).toBe(0);
  });

  it('frees the slot when a job fails, and reports the failure', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const failing = scheduler.submit('a', e.render('a1'));
    const next = scheduler.submit('a', e.render('a2'));
    await flush();

    e.fail('a1', new Error('engine choked'));
    await expect(failing.promise).rejects.toThrow('engine choked');
    await flush();
    e.finish('a2');

    await expect(next.promise).resolves.toBe('a2');
  });

  it('swallows a failure that comes after a cancel', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const job = scheduler.submit('a', e.render('a1'));
    await flush();
    job.cancel();
    e.fail('a1', new Error('late failure'));
    await flush();

    await expect(job.promise).resolves.toBeNull();
    expect(scheduler.running).toBe(0);
  });

  it('frees the slot when a job throws before returning a promise', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    const broken = scheduler.submit('a', () => {
      throw new Error('sync throw');
    });
    const next = scheduler.submit('a', e.render('a2'));

    await expect(broken.promise).rejects.toThrow('sync throw');
    await flush();
    e.finish('a2');
    await expect(next.promise).resolves.toBe('a2');
  });

  it('runs background jobs only when no line is waiting', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    scheduler.submit('a', e.render('a1'));
    scheduler.submit('warm', e.render('warm'), { background: true });
    scheduler.submit('b', e.render('b1'));

    for (const name of ['a1', 'b1', 'warm']) {
      await flush();
      e.finish(name);
    }
    await flush();

    expect(e.started).toEqual(['a1', 'b1', 'warm']);
  });

  it('can cancel a waiting background job', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();

    scheduler.submit('a', e.render('a1'));
    const warm = scheduler.submit('warm', e.render('warm'), {
      background: true,
    });
    warm.cancel();
    await flush();
    e.finish('a1');
    await flush();

    await expect(warm.promise).resolves.toBeNull();
    expect(e.started).toEqual(['a1']);
  });

  it('tells when a job reaches the engine', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();
    scheduler.submit('a', e.render('a1'));
    const second = scheduler.submit('b', e.render('b1'));
    let started = false;
    void second.started.then(() => (started = true));

    await flush();
    expect(started).toBe(false);

    e.finish('a1');
    await flush();
    expect(started).toBe(true);
    expect(second.state).toBe('running');
  });

  it('releases anyone waiting for a start when the job is cancelled first', async () => {
    const scheduler = new SynthesisScheduler();
    const e = engine();
    scheduler.submit('a', e.render('a1'));
    const waiting = scheduler.submit('a', e.render('a2'));

    waiting.cancel();

    await expect(waiting.started).resolves.toBeUndefined();
    await flush();
    expect(e.started).toEqual(['a1']);
  });

  it('starts a job on a later tick, never inside submit()', () => {
    const scheduler = new SynthesisScheduler();
    const run = vi.fn(async () => 'x');

    scheduler.submit('a', run);

    expect(run).not.toHaveBeenCalled();
  });

  it('never starts a job cancelled before its turn came', async () => {
    const scheduler = new SynthesisScheduler();
    const run = vi.fn(async () => 'x');

    // Takes the free slot at once, but has not run yet.
    const job = scheduler.submit('a', run);
    job.cancel();
    await flush();

    expect(run).not.toHaveBeenCalled();
    await expect(job.promise).resolves.toBeNull();
    expect(scheduler.running).toBe(0);
  });

  it('gives back the slot of a request that never settles, as a last resort', async () => {
    vi.useFakeTimers();
    const scheduler = new SynthesisScheduler({ slotTimeoutMs: 1_000 });
    const e = engine();

    const stuck = scheduler.submit('a', e.render('stuck'));
    scheduler.submit('a', e.render('next'));
    await vi.advanceTimersByTimeAsync(999);
    expect(e.started).toEqual(['stuck']);

    await vi.advanceTimersByTimeAsync(1);
    await expect(stuck.promise).resolves.toBeNull();
    expect(e.started).toEqual(['stuck', 'next']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('giving its slot back')
    );
  });

  it('tells a job whose slot was given back that it was cancelled, so it sends nothing more', async () => {
    vi.useFakeTimers();
    const scheduler = new SynthesisScheduler({ slotTimeoutMs: 1_000 });
    const e = engine();
    const query = deferred<void>();
    const sliceRequest = vi.fn();

    const stuck = scheduler.submit('a', async (token) => {
      await query.promise; // a query that ignores its own timeout
      if (token.cancelled) return null;
      sliceRequest();
      return 'slice';
    });
    scheduler.submit('a', e.render('next'));

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(stuck.promise).resolves.toBeNull();
    expect(e.started).toEqual(['next']);

    // The hung query answers at last, while 'next' holds the slot.
    query.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sliceRequest).not.toHaveBeenCalled();
  });

  it('leaves no timer behind once a job is done', async () => {
    vi.useFakeTimers();
    const scheduler = new SynthesisScheduler();
    const job = scheduler.submit('a', async () => 'quick');

    await expect(job.promise).resolves.toBe('quick');
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });
});
