import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLiveComponents,
  isLiveComponentMessage,
  isSettledComponentMessage,
  liveComponentCount,
  SETTLED_COMPONENT_MEMORY_MS,
  stopLiveComponents,
  trackLiveComponents,
} from '../liveComponents.js';

afterEach(() => {
  clearLiveComponents();
  vi.useRealTimers();
});

describe('live component tracking', () => {
  it('marks a message live until it is untracked', () => {
    const untrack = trackLiveComponents('m1');

    expect(isLiveComponentMessage('m1')).toBe(true);
    expect(isLiveComponentMessage('m2')).toBe(false);

    untrack();
    expect(isLiveComponentMessage('m1')).toBe(false);
    expect(liveComponentCount()).toBe(0);
  });

  it('keeps a message live while any of its collectors still runs', () => {
    const first = trackLiveComponents('m1');
    const second = trackLiveComponents('m1');

    first();
    expect(isLiveComponentMessage('m1')).toBe(true);

    second();
    expect(isLiveComponentMessage('m1')).toBe(false);
  });

  it('untracking twice is harmless', () => {
    const untrack = trackLiveComponents('m1');
    untrack();
    untrack();
    trackLiveComponents('m1');

    expect(isLiveComponentMessage('m1')).toBe(true);
  });
});

describe('recently settled messages', () => {
  it('remembers a message for a while after its last collector ended', () => {
    vi.useFakeTimers();
    const untrack = trackLiveComponents('m1');
    expect(isSettledComponentMessage('m1')).toBe(false);

    untrack();
    expect(isSettledComponentMessage('m1')).toBe(true);
    expect(isSettledComponentMessage('m2')).toBe(false);

    vi.advanceTimersByTime(SETTLED_COMPONENT_MEMORY_MS - 1);
    expect(isSettledComponentMessage('m1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isSettledComponentMessage('m1')).toBe(false);
  });

  it('is not settled while another collector on it still runs, or once one opens again', () => {
    const first = trackLiveComponents('m1');
    const second = trackLiveComponents('m1');
    first();
    expect(isSettledComponentMessage('m1')).toBe(false);

    second();
    expect(isSettledComponentMessage('m1')).toBe(true);
    trackLiveComponents('m1');
    expect(isSettledComponentMessage('m1')).toBe(false);
  });

  it('does not grow without bound', () => {
    vi.useFakeTimers();
    trackLiveComponents('old')();
    vi.advanceTimersByTime(SETTLED_COMPONENT_MEMORY_MS);
    trackLiveComponents('new')();

    // The expired entry was pruned, not merely reported as expired.
    expect(isSettledComponentMessage('old', 0)).toBe(false);
    expect(isSettledComponentMessage('new')).toBe(true);
  });

  it('is forgotten by clearLiveComponents', () => {
    trackLiveComponents('m1')();
    clearLiveComponents();

    expect(isSettledComponentMessage('m1')).toBe(false);
  });
});

describe('stopLiveComponents', () => {
  it('stops every collector with the reason and waits for them to finish', async () => {
    const order: string[] = [];
    const stopA = vi.fn();
    const stopB = vi.fn();
    let finishA!: () => void;
    trackLiveComponents('a', {
      stop: stopA,
      ended: new Promise<void>((resolve) => {
        finishA = () => {
          order.push('a ended');
          resolve();
        };
      }),
    });
    trackLiveComponents('b', { stop: stopB });

    const stopping = stopLiveComponents({ timeoutMs: 5_000 }).then(() =>
      order.push('stopped')
    );
    await Promise.resolve();

    expect(stopA).toHaveBeenCalledWith('shutdown');
    expect(stopB).toHaveBeenCalledWith('shutdown');
    expect(order).toEqual([]);

    finishA();
    await stopping;
    expect(order).toEqual(['a ended', 'stopped']);
  });

  it('gives up waiting after the timeout', async () => {
    vi.useFakeTimers();
    trackLiveComponents('a', { stop: vi.fn(), ended: new Promise(() => {}) });
    let done = false;

    const stopping = stopLiveComponents({ timeoutMs: 1_000 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(done).toBe(true);
  });

  it('keeps stopping the rest when one collector throws', async () => {
    const stopB = vi.fn();
    trackLiveComponents('a', {
      stop: () => {
        throw new Error('already ended');
      },
    });
    trackLiveComponents('b', { stop: stopB });

    await expect(
      stopLiveComponents({ timeoutMs: 10, reason: 'test' })
    ).resolves.toBeUndefined();
    expect(stopB).toHaveBeenCalledWith('test');
  });
});
