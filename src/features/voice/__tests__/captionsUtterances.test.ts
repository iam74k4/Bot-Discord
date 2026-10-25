import { describe, expect, it, vi } from 'vitest';
import { UtteranceCollector, type Utterance } from '../captions/utterances.js';

/** 20 ms of 48 kHz mono 16-bit audio, as one decoded Opus frame. */
const FRAME = Buffer.alloc(960 * 2, 1);

function collector(limits = { minMs: 400, maxMs: 1000 }) {
  const emitted: Utterance[] = [];
  const c = new UtteranceCollector('user-1', (u) => emitted.push(u), limits);
  return { c, emitted };
}

function pushFrames(c: UtteranceCollector, count: number, startAt = 1_000) {
  for (let i = 0; i < count; i++) c.push(FRAME, startAt + i * 20);
}

describe('UtteranceCollector', () => {
  it('emits what was said when the speaker stops', () => {
    const { c, emitted } = collector();
    pushFrames(c, 30); // 600 ms

    expect(emitted).toEqual([]);
    c.end();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ userId: 'user-1', startedAt: 1_000 });
    expect(emitted[0].pcm.length).toBe(30 * FRAME.length);
  });

  it('drops bursts shorter than the minimum', () => {
    const { c, emitted } = collector();
    pushFrames(c, 10); // 200 ms
    c.end();

    expect(emitted).toEqual([]);
  });

  it('cuts a long monologue without waiting for the speaker to stop', () => {
    const { c, emitted } = collector();
    pushFrames(c, 50); // exactly 1000 ms

    expect(emitted).toHaveLength(1);
    expect(emitted[0].pcm.length).toBe(50 * FRAME.length);

    pushFrames(c, 25, 5_000); // the next 500 ms
    c.end();
    expect(emitted).toHaveLength(2);
    expect(emitted[1].startedAt).toBe(5_000);
  });

  it('emits nothing for an end with nothing buffered', () => {
    const emit = vi.fn();
    new UtteranceCollector('user-1', emit).end();

    expect(emit).not.toHaveBeenCalled();
  });
});
