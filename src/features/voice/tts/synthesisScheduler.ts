import { getErrorMessage, logger } from '../../../shared/utils/logger.js';

/**
 * One VOICEVOX engine serves every guild, and it is the bottleneck.
 *
 * The engine works through requests one at a time, in no particular order,
 * and it keeps working on a request after the client has given up on it. So
 * firing requests at it as lines arrive does not make anything faster: a
 * burst in one guild fills the engine with work whose results arrive too
 * late, each new request waits behind the abandoned ones, and lines time out
 * and go missing in every guild.
 *
 * The scheduler is the single way requests reach the engine:
 * - At most `concurrency` jobs (default 1) are with the engine at once, so a
 *   request's timeout starts when the engine is actually free.
 * - Guilds take turns: each key (one reading session) has its own FIFO queue,
 *   and the next job always comes from the key served least recently, so one
 *   busy chat cannot starve the others. Order within a key is kept.
 * - Turns are taken per line, not per request. A job queued behind another
 *   of its key (`after`: the rest of a line) does not count as a new turn,
 *   so once a line is being rendered its remaining slices go before the
 *   next line of any guild that has already had its turn. The trade-off: a
 *   guild whose turn comes up while a line elsewhere is rendering still goes
 *   between that line's first slice and the rest, so the line can pause once,
 *   mid-sentence, for about one request; in exchange that guild's line starts
 *   a whole line's render sooner. It never pauses once per slice.
 * - A queued job can be cancelled for free; it never reaches the engine. A
 *   running job that is cancelled has its result thrown away, but it keeps
 *   its slot until its request settles: the engine is still busy with it,
 *   and freeing the slot early would recreate the pile-up described above.
 * - Background jobs (warming up a voice model) run only when no line is
 *   waiting.
 */

/** Passed to a running job so it can stop between requests once cancelled. */
export interface JobToken {
  readonly cancelled: boolean;
}

export type JobState = 'queued' | 'running' | 'done';

export interface ScheduledJob<T> {
  /** The job's result; null when it was cancelled. Rejects when it failed. */
  readonly promise: Promise<T | null>;
  /** Resolves when the job reaches the engine, or is cancelled before. */
  readonly started: Promise<void>;
  readonly state: JobState;
  cancel(): void;
}

export interface SubmitOptions {
  /**
   * Queue directly behind this job of the same key, or at the front of the
   * key's queue when that job has already started: the rest of a line goes
   * ahead of the next line. Such a job continues its key's turn instead of
   * taking a new one.
   */
  after?: ScheduledJob<unknown>;
  /** Run only when no foreground job is waiting. */
  background?: boolean;
}

export interface SchedulerOptions {
  /** Jobs allowed at the engine at once. */
  concurrency?: number;
  /**
   * A job whose request never settles gives its slot back after this long,
   * so a hung request cannot silence every guild. Requests carry their own,
   * much shorter timeouts; this is only a last resort.
   */
  slotTimeoutMs?: number;
}

const DEFAULT_SLOT_TIMEOUT_MS = 120_000;

interface KeyState {
  queue: Entry[];
  /** When this key was last served; 0 for never, which goes first. */
  lastServed: number;
  /** Its jobs at the engine; a key stays known while one is running. */
  running: number;
}

interface Entry {
  key: string;
  run: (token: JobToken) => Promise<unknown>;
  token: { cancelled: boolean };
  state: JobState;
  background: boolean;
  /** Queued behind another job of its key: part of the same turn. */
  continuation: boolean;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  markStarted(): void;
}

export class SynthesisScheduler {
  /** Foreground queues by key; Map order breaks ties between keys. */
  private readonly keys = new Map<string, KeyState>();
  private readonly backgroundQueue: Entry[] = [];
  private served = 0;
  private readonly entries = new WeakMap<ScheduledJob<unknown>, Entry>();
  private active = 0;
  private readonly concurrency: number;
  private readonly slotTimeoutMs: number;

  constructor({
    concurrency = 1,
    slotTimeoutMs = DEFAULT_SLOT_TIMEOUT_MS,
  }: SchedulerOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.slotTimeoutMs = slotTimeoutMs;
  }

  /** Jobs at the engine right now. */
  get running(): number {
    return this.active;
  }

  /** Jobs waiting for a slot. */
  get waiting(): number {
    let count = this.backgroundQueue.length;
    for (const state of this.keys.values()) count += state.queue.length;
    return count;
  }

  submit<T>(
    key: string,
    run: (token: JobToken) => Promise<T>,
    { after, background = false }: SubmitOptions = {}
  ): ScheduledJob<T> {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T | null>((res, rej) => {
      resolve = res as (value: unknown) => void;
      reject = rej;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((res) => {
      markStarted = res;
    });

    const entry: Entry = {
      key,
      run,
      token: { cancelled: false },
      state: 'queued',
      background,
      continuation: false,
      settled: false,
      resolve: (value) => {
        if (entry.settled) return;
        entry.settled = true;
        resolve(value);
      },
      reject: (error) => {
        if (entry.settled) return;
        entry.settled = true;
        reject(error);
      },
      markStarted,
    };

    const job: ScheduledJob<T> = {
      promise,
      started,
      get state() {
        return entry.state;
      },
      cancel: () => this.cancel(entry),
    };
    this.entries.set(job, entry);

    if (background) {
      this.backgroundQueue.push(entry);
    } else {
      this.enqueue(entry, after ? this.entries.get(after) : undefined);
    }
    this.drain();
    return job;
  }

  private enqueue(entry: Entry, after: Entry | undefined): void {
    let state = this.keys.get(entry.key);
    if (!state) {
      state = { queue: [], lastServed: 0, running: 0 };
      this.keys.set(entry.key, state);
    }
    if (after && after.key === entry.key) {
      entry.continuation = true;
      const index = state.queue.indexOf(after);
      state.queue.splice(index === -1 ? 0 : index + 1, 0, entry);
      return;
    }
    state.queue.push(entry);
  }

  /** Forget a key with nothing waiting and nothing running. */
  private prune(key: string): void {
    const state = this.keys.get(key);
    if (state && state.queue.length === 0 && state.running === 0) {
      this.keys.delete(key);
    }
  }

  private cancel(entry: Entry): void {
    if (entry.state === 'done') return;
    if (entry.state === 'queued') {
      const queue = entry.background
        ? this.backgroundQueue
        : this.keys.get(entry.key)?.queue;
      const index = queue?.indexOf(entry) ?? -1;
      if (queue && index !== -1) queue.splice(index, 1);
      if (!entry.background) this.prune(entry.key);
      entry.state = 'done';
      entry.markStarted();
      entry.resolve(null);
      return;
    }
    // Running: the engine is still working on it. Drop the result now, give
    // the slot back only when the request settles.
    entry.token.cancelled = true;
    entry.resolve(null);
  }

  /**
   * The next job: from the key served least recently, background last. The
   * rest of a line keeps its key's place, so the line finishes rendering
   * before a key that has already had its turn goes again.
   */
  private take(): Entry | undefined {
    let next: KeyState | undefined;
    for (const state of this.keys.values()) {
      if (state.queue.length === 0) continue;
      if (!next || state.lastServed < next.lastServed) next = state;
    }
    if (next) {
      const entry = next.queue.shift();
      if (!entry?.continuation) next.lastServed = ++this.served;
      next.running++;
      return entry;
    }
    return this.backgroundQueue.shift();
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const entry = this.take();
      if (!entry) return;
      this.start(entry);
    }
  }

  private start(entry: Entry): void {
    entry.state = 'running';
    entry.markStarted();
    this.active++;

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      entry.state = 'done';
      this.active--;
      if (!entry.background) {
        const state = this.keys.get(entry.key);
        if (state) state.running--;
        this.prune(entry.key);
      }
      this.drain();
    };

    const timer = setTimeout(() => {
      logger.warn(
        `TTS engine request still running after ${this.slotTimeoutMs} ms; giving its slot back`
      );
      // Its slot now belongs to someone else: it must not send the engine
      // another request (the next slice after its query, say).
      entry.token.cancelled = true;
      entry.resolve(null);
      release();
    }, this.slotTimeoutMs);
    timer.unref?.();

    // Started on a microtask so a job never runs inside the caller's submit().
    void Promise.resolve()
      .then(() => (entry.token.cancelled ? null : entry.run(entry.token)))
      .then(
        (value) => entry.resolve(entry.token.cancelled ? null : value),
        (error: unknown) => {
          if (entry.token.cancelled) {
            logger.debug(
              `Cancelled TTS job failed after cancel: ${getErrorMessage(error)}`
            );
            entry.resolve(null);
          } else {
            entry.reject(error);
          }
        }
      )
      .finally(release);
  }
}
