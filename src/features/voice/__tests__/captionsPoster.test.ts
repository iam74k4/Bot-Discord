import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionPoster } from '../captions/captionPoster.js';

const OPTIONS = { minIntervalMs: 1_000, maxChars: 30, maxPending: 4 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

function poster(send = vi.fn().mockResolvedValue(undefined)) {
  return { send, p: new CaptionPoster(send, OPTIONS) };
}

describe('CaptionPoster', () => {
  it('sends the first line right away', async () => {
    const { send, p } = poster();

    p.add('a: hello');
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledWith('a: hello');
  });

  it('combines lines that arrive during the cooldown into one message', async () => {
    const { send, p } = poster();
    p.add('a: one');
    await vi.advanceTimersByTimeAsync(0);

    p.add('b: two');
    p.add('c: three');
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenNthCalledWith(2, 'b: two\nc: three');
  });

  it('splits at the length limit and sends the rest after the next gap', async () => {
    const { send, p } = poster();
    p.add('x'.repeat(20));
    p.add('y'.repeat(20));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenLastCalledWith('x'.repeat(20));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenLastCalledWith('y'.repeat(20));
  });

  it('shortens a single line longer than a message', async () => {
    const { send, p } = poster();

    p.add('z'.repeat(50));
    await vi.advanceTimersByTimeAsync(0);

    expect(send).toHaveBeenCalledWith(`${'z'.repeat(29)}…`);
  });

  it('drops the oldest lines when too many are waiting', async () => {
    let release!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const { p } = poster(send);
    p.add('0');
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 6; i++) p.add(String(i));

    release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenLastCalledWith('3\n4\n5\n6');
  });

  it('keeps going after a failed send', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Missing Access'))
      .mockResolvedValue(undefined);
    const { p } = poster(send);

    p.add('lost');
    await vi.advanceTimersByTimeAsync(0);
    p.add('next');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenLastCalledWith('next');
  });

  it('sends nothing after stop', async () => {
    const { send, p } = poster();
    p.add('a');
    await vi.advanceTimersByTimeAsync(0);
    p.add('b');

    p.stop();
    p.add('c');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
