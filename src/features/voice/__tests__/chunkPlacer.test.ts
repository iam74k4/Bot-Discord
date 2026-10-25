import { describe, expect, it } from 'vitest';
import {
  ChunkPlacer,
  MAX_LEAD_SAMPLES,
  RESYNC_LATE_SAMPLES,
} from '../recording/chunkPlacer.js';

const FRAME = 960; // one 20 ms Opus frame at 48 kHz

/** Deterministic jitter in [-max, max] samples. */
function jitter(seed: number, max: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.round((state / 0x100000000) * 2 * max - max);
  };
}

describe('ChunkPlacer', () => {
  it('places the first chunk of a talk spurt at its arrival time', () => {
    const placer = new ChunkPlacer();

    expect(placer.place(10_000, FRAME)).toBe(10_000 - FRAME);
  });

  it('lays 600 jittered frames end to end, with no overlap or gap at any join', () => {
    const placer = new ChunkPlacer();
    const noise = jitter(1, 240); // +/-5 ms
    const starts: Array<number | null> = [];

    for (let i = 1; i <= 600; i++) {
      starts.push(placer.place(i * FRAME + noise(), FRAME));
    }

    expect(starts).not.toContain(null);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBe(FRAME);
    }
  });

  it('never stacks frames that queued up during a stall', () => {
    const placer = new ChunkPlacer();
    placer.place(FRAME, FRAME);
    // A 676 ms event-loop block: 34 frames are handled at the same instant.
    const arrival = FRAME + 676 * 48;
    const starts = Array.from({ length: 34 }, () =>
      placer.place(arrival, FRAME)
    );

    expect(new Set(starts).size).toBe(34);
    expect(starts).not.toContain(null);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBe(starts[i - 1]! + FRAME);
    }
  });

  it('snaps forward when the stream falls more than 60 ms behind (a pause or lost packets)', () => {
    const placer = new ChunkPlacer();
    placer.place(FRAME, FRAME); // next expected start: FRAME

    // Exactly at the tolerance: still contiguous.
    expect(placer.place(2 * FRAME + RESYNC_LATE_SAMPLES, FRAME)).toBe(FRAME);
    // One sample past it (relative to the new expectation): resync.
    const arrivalEnd = 2 * FRAME + FRAME + RESYNC_LATE_SAMPLES + 1;
    expect(placer.place(arrivalEnd, FRAME)).toBe(arrivalEnd - FRAME);
  });

  it('never moves backwards, even when a frame arrives early', () => {
    const placer = new ChunkPlacer();
    const first = placer.place(100_000, FRAME);

    const second = placer.place(90_000, FRAME);

    expect(second).toBe(first! + FRAME);
  });

  it('keeps a stream that never pauses within a second of the wall clock, without overlapping itself', () => {
    // Ten minutes of an open mic whose sender clock runs 0.5% fast (a frame
    // every 19.9 ms), with a 676 ms event-loop stall every 10 s. Laid end to
    // end, the fast clock alone would put this speaker 3 s in the future.
    const placer = new ChunkPlacer();
    const frameMs = 19.9;
    const stallEveryMs = 10_000;
    const stallMs = 676;
    let lastStart: number | null = null;
    let maxLead = 0;
    let dropped = 0;
    const frames = Math.floor(600_000 / frameMs);

    for (let i = 0; i < frames; i++) {
      const sentMs = i * frameMs;
      const intoCycle = sentMs % stallEveryMs;
      // Frames sent during a stall are all handled when it ends.
      const handledMs =
        intoCycle < stallMs ? sentMs - intoCycle + stallMs : sentMs;
      const arrivalEnd = Math.round(handledMs * 48) + FRAME;
      const start = placer.place(arrivalEnd, FRAME);
      if (start === null) {
        dropped++;
        continue;
      }
      if (lastStart !== null) {
        expect(start).toBeGreaterThanOrEqual(lastStart + FRAME);
      }
      lastStart = start;
      maxLead = Math.max(maxLead, start - (arrivalEnd - FRAME));
    }

    expect(maxLead).toBeLessThanOrEqual(MAX_LEAD_SAMPLES + FRAME);
    // The valve had to open, and dropped only a small share of the audio.
    expect(dropped).toBeGreaterThan(0);
    expect(dropped / frames).toBeLessThan(0.02);
  });

  it('drops frames, never overwrites, until the clock catches up, then goes on end to end', () => {
    const placer = new ChunkPlacer();
    placer.place(FRAME, FRAME);
    // Force a lead just over the limit with frames that all arrive at once.
    const burst = Math.ceil(MAX_LEAD_SAMPLES / FRAME) + 2;
    let next = 0;
    for (let i = 0; i < burst; i++) {
      const start = placer.place(FRAME, FRAME);
      if (start !== null) next = start + FRAME;
    }

    // While the placement is still ahead of the arrival time: dropped.
    expect(placer.place(next - FRAME, FRAME)).toBeNull();
    expect(placer.place(next, FRAME)).toBeNull();
    // Caught up: placed where the last frame ended, not on top of it.
    expect(placer.place(next + FRAME, FRAME)).toBe(next);
    expect(placer.place(next + 2 * FRAME, FRAME)).toBe(next + FRAME);
  });

  it('never drops frames of ordinary speech', () => {
    const placer = new ChunkPlacer();
    const noise = jitter(7, 960); // +/-20 ms
    for (let i = 1; i <= 3000; i++) {
      expect(placer.place(i * FRAME + noise(), FRAME)).not.toBeNull();
    }
  });

  it('starts fresh for a new talk spurt (a new placer)', () => {
    const first = new ChunkPlacer();
    first.place(FRAME, FRAME);
    first.place(FRAME, FRAME);

    const next = new ChunkPlacer();
    expect(next.place(FRAME, FRAME)).toBe(0);
  });
});
