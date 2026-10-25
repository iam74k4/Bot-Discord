import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ChannelMixRing,
  ChannelMixRingManager,
} from '../recording/channelMixRing.js';

vi.mock('../../../config/index.js', () => ({
  env: {
    AUDIO_BUFFER_DURATION: 60,
  },
}));

describe('ChannelMixRing', () => {
  const epoch = 1_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sums two speakers at the same global sample', () => {
    const endMs = epoch + 20;
    const ring = new ChannelMixRing(10, epoch);
    ring.addMonoPcmInt16(constantPcm(960, 3000), endMs);
    ring.addMonoPcmInt16(constantPcm(960, 4000), endMs);

    const out = ring.extractLastSeconds(0.02, endMs);

    expect(out.length).toBe(960 * 2);
    // Same output as one speaker at 3000 + 4000, and louder than either.
    expect(out.equals(singleSpeaker(7000))).toBe(true);
    expect(out.readInt16LE(0)).toBeGreaterThan(
      singleSpeaker(4000).readInt16LE(0)
    );
  });

  it('overwrites ring slot when global sample wraps past buffer length', () => {
    // One lap is 20ms (960 samples). The late frame lands on exactly the
    // slots the early frame used one lap before.
    const ring = new ChannelMixRing(0.02, epoch);
    ring.addMonoPcmInt16(constantPcm(960, 5000), epoch + 20);
    ring.addMonoPcmInt16(constantPcm(960, 7000), epoch + 40);

    const out = ring.extractLastSeconds(0.02, epoch + 40);

    // Only the late frame is heard: the early one is replaced, not summed.
    const lateOnly = new ChannelMixRing(0.02, epoch);
    lateOnly.addMonoPcmInt16(constantPcm(960, 7000), epoch + 40);
    expect(out.equals(lateOnly.extractLastSeconds(0.02, epoch + 40))).toBe(
      true
    );
    expect(out.readInt16LE(0)).toBeGreaterThan(0);
  });

  it('does not replay a slot written a full lap earlier', () => {
    // One lap is 20ms of samples. Audio written in lap 0 must not be read
    // back as if it belonged to lap 1 at the same ring offset.
    const ring = new ChannelMixRing(0.02, epoch);

    const pcm = Buffer.alloc(960 * 2);
    pcm.fill(0);
    for (let i = 0; i < 960; i++) {
      pcm.writeInt16LE(9000, i * 2);
    }
    ring.addMonoPcmInt16(pcm, epoch + 20);

    // Read the same ring offsets one lap later, with nothing written since.
    const out = ring.extractLastSeconds(0.02, epoch + 40);
    expect(maxAbsInt16(out)).toBe(0);
  });

  it('keeps mixing correctly after more laps than the generation counter holds', () => {
    const ring = new ChannelMixRing(0.02, epoch);

    // 0xffff laps returns the generation marker to its starting value; the
    // slot must still be recognised as belonging to the current lap.
    const lapMs = 20;
    const wrapAroundMs = epoch + lapMs * 0x10000;

    const pcm = Buffer.alloc(960 * 2);
    for (let i = 0; i < 960; i++) {
      pcm.writeInt16LE(6000, i * 2);
    }
    ring.addMonoPcmInt16(pcm, wrapAroundMs);

    const out = ring.extractLastSeconds(0.02, wrapAroundMs);
    expect(maxAbsInt16(out)).toBeGreaterThan(4000);
  });

  it('ignores an empty chunk', () => {
    const ring = new ChannelMixRing(1, epoch);

    ring.addMonoPcmInt16(Buffer.alloc(0), epoch + 100);

    expect(maxAbsInt16(ring.extractLastSeconds(0.1, epoch + 100))).toBe(0);
  });

  it('places audio at its wall-clock receive time', () => {
    const ring = new ChannelMixRing(1, epoch);
    // 20ms frame received 500ms after the epoch.
    ring.addMonoPcmInt16(constantPcm(960, 8000), epoch + 500);

    // The 20ms window ending at receive time holds it ...
    expect(
      minAbsInt16(ring.extractLastSeconds(0.02, epoch + 500))
    ).toBeGreaterThan(0);
    // ... the 20ms before it and the 20ms after it are silent.
    expect(maxAbsInt16(ring.extractLastSeconds(0.02, epoch + 480))).toBe(0);
    expect(maxAbsInt16(ring.extractLastSeconds(0.02, epoch + 520))).toBe(0);
  });

  it('keeps the in-epoch half of a chunk that started before the epoch', () => {
    const ring = new ChannelMixRing(1, epoch);
    // 20ms frame ending 10ms after the epoch: first 10ms predate the ring.
    ring.addMonoPcmInt16(constantPcm(960, 8000), epoch + 10);

    const out = ring.extractLastSeconds(0.01, epoch + 10);
    expect(out.length).toBe(480 * 2);
    expect(minAbsInt16(out)).toBeGreaterThan(0);
  });

  it('returns floor(seconds * 48000) samples of s16le', () => {
    const ring = new ChannelMixRing(1, epoch);

    expect(ring.extractLastSeconds(0.5, epoch + 1000).length).toBe(24000 * 2);
    expect(ring.extractLastSeconds(1 / 48000, epoch).length).toBe(2);
  });

  it('never returns more than the ring holds', () => {
    const ring = new ChannelMixRing(0.1, epoch);

    expect(ring.extractLastSeconds(10, epoch + 10_000).length).toBe(
      0.1 * 48000 * 2
    );
  });

  it('defaults the epoch and read time to now', () => {
    const ring = new ChannelMixRing(1); // epoch = now
    // A frame that ended at construction time predates the ring entirely.
    ring.addMonoPcmInt16(constantPcm(960, 8000), Date.now());
    expect(maxAbsInt16(ring.extractLastSeconds(0.02))).toBe(0);

    vi.setSystemTime(epoch + 20);
    ring.addMonoPcmInt16(constantPcm(960, 8000), Date.now());

    expect(maxAbsInt16(ring.extractLastSeconds(0.02))).toBeGreaterThan(0);
  });

  it('soft-limits loud mixes without wrapping around int16', () => {
    const ring = new ChannelMixRing(1, epoch);
    const loud = constantPcm(960, 32767);
    // Four speakers at full scale sum far beyond int16.
    for (let i = 0; i < 4; i++) ring.addMonoPcmInt16(loud, epoch + 20);

    const single = new ChannelMixRing(1, epoch);
    single.addMonoPcmInt16(loud, epoch + 20);

    const mixed = ring.extractLastSeconds(0.02, epoch + 20).readInt16LE(0);
    const alone = single.extractLastSeconds(0.02, epoch + 20).readInt16LE(0);
    expect(mixed).toBeGreaterThan(alone);
    expect(mixed).toBeLessThanOrEqual(32767);
    expect(alone).toBeGreaterThan(0);
  });

  it('soft-limits with a tanh curve whose knee is at 24000', () => {
    // round(tanh(v / 24000) * 32767), pinned so loudness cannot drift.
    expect(singleSpeaker(0).readInt16LE(0)).toBe(0);
    expect(singleSpeaker(2400).readInt16LE(0)).toBe(3266);
    expect(singleSpeaker(12000).readInt16LE(0)).toBe(15142);
    expect(singleSpeaker(24000).readInt16LE(0)).toBe(24955);
    expect(singleSpeaker(-12000).readInt16LE(0)).toBe(-15142);
  });

  it('keeps the sign and symmetry of negative samples', () => {
    const pos = new ChannelMixRing(1, epoch);
    const neg = new ChannelMixRing(1, epoch);
    pos.addMonoPcmInt16(constantPcm(960, 12000), epoch + 20);
    neg.addMonoPcmInt16(constantPcm(960, -12000), epoch + 20);

    const p = pos.extractLastSeconds(0.02, epoch + 20).readInt16LE(0);
    const n = neg.extractLastSeconds(0.02, epoch + 20).readInt16LE(0);
    expect(p).toBeGreaterThan(0);
    expect(n).toBe(-p);
  });

  it('cancels out speakers in opposite phase', () => {
    const ring = new ChannelMixRing(1, epoch);
    ring.addMonoPcmInt16(constantPcm(960, 5000), epoch + 20);
    ring.addMonoPcmInt16(constantPcm(960, -5000), epoch + 20);

    expect(maxAbsInt16(ring.extractLastSeconds(0.02, epoch + 20))).toBe(0);
  });

  it('reports its memory footprint (int32 mix per sample + one spare page, uint16 marker per page)', () => {
    const ring = new ChannelMixRing(10, epoch);

    expect(ring.getApproxSizeMB()).toBeCloseTo(
      ringBytes(10) / (1024 * 1024),
      6
    );
    // A third less than the old per-sample generation array (6 bytes/sample).
    expect(ring.getApproxSizeMB()).toBeLessThan(
      (10 * 48000 * 6 * 0.7) / (1024 * 1024)
    );
  });

  it('extractLastSeconds returns silence before epoch', () => {
    const ringEpoch = epoch + 5000;
    const ring = new ChannelMixRing(5, ringEpoch);
    // 50ms of audio ending 10ms after the epoch: 40ms of it predates the ring.
    ring.addMonoPcmInt16(constantPcm(2400, 8000), ringEpoch + 10);

    // 100ms window ending 20ms after the epoch: 80ms before, 20ms after.
    const out = ring.extractLastSeconds(0.1, ringEpoch + 20);
    const samples = (fromMs: number, toMs: number) =>
      out.subarray(fromMs * 48 * 2, toMs * 48 * 2);

    expect(out.length).toBe(4800 * 2);
    // Before the epoch: silent, even though the chunk started there.
    expect(maxAbsInt16(samples(0, 80))).toBe(0);
    // First 10ms after the epoch: the in-epoch part of the chunk.
    expect(samples(80, 90).equals(singleSpeaker(8000).subarray(0, 960))).toBe(
      true
    );
    // After the chunk ended: silent again.
    expect(maxAbsInt16(samples(90, 100))).toBe(0);
  });
});

/** Bytes a ring of `seconds` allocates: whole pages plus one spare. */
function ringBytes(seconds: number): number {
  const pages = Math.ceil((seconds * 48000) / 960) + 1;
  return pages * 960 * 4 + pages * 2;
}

/** The 20ms read-back of a ring holding one speaker at a constant level. */
function singleSpeaker(value: number): Buffer {
  const ring = new ChannelMixRing(1, 0);
  ring.addMonoPcmInt16(constantPcm(960, value), 20);
  return ring.extractLastSeconds(0.02, 20);
}

function constantPcm(samples: number, value: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

function minAbsInt16(buf: Buffer): number {
  let m = Infinity;
  for (let i = 0; i < buf.length; i += 2) {
    m = Math.min(m, Math.abs(buf.readInt16LE(i)));
  }
  return m;
}

function maxAbsInt16(buf: Buffer): number {
  let m = 0;
  for (let i = 0; i < buf.length; i += 2) {
    m = Math.max(m, Math.abs(buf.readInt16LE(i)));
  }
  return m;
}

describe('ChannelMixRingManager', () => {
  it('remove drops channel', () => {
    const mgr = new ChannelMixRingManager();
    mgr.getOrCreate('c1');
    expect(mgr.getTotalMixBufferSizeMB()).toBeGreaterThan(0);
    mgr.remove('c1');
    expect(mgr.extractLastSeconds('c1', 1).length).toBe(0);
  });

  it('returns the same ring for a channel and a separate one per channel', () => {
    const mgr = new ChannelMixRingManager();

    const a = mgr.getOrCreate('a');
    const b = mgr.getOrCreate('b');
    expect(mgr.getOrCreate('a')).toBe(a);
    expect(mgr.getOrCreate('b')).toBe(b);
    // Plain identity check on purpose: `expect(b).not.toBe(a)` makes Vitest
    // deep-compare two multi-megabyte rings for its hint message, which takes
    // tens of seconds whenever both were created in the same millisecond.
    expect(b === a).toBe(false);
  });

  it('sizes rings from AUDIO_BUFFER_DURATION and sums them', () => {
    const mgr = new ChannelMixRingManager();
    const perRingMB = ringBytes(60) / (1024 * 1024);

    mgr.getOrCreate('a');
    expect(mgr.getTotalMixBufferSizeMB()).toBeCloseTo(perRingMB, 6);
    mgr.getOrCreate('b');
    expect(mgr.getTotalMixBufferSizeMB()).toBeCloseTo(2 * perRingMB, 6);
  });

  it('reads a channel ring at the requested time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(5_000_000);
      const mgr = new ChannelMixRingManager();
      mgr.getOrCreate('a').addMonoPcmInt16(constantPcm(960, 8000), 5_000_020);

      expect(
        maxAbsInt16(mgr.extractLastSeconds('a', 0.02, 5_000_020))
      ).toBeGreaterThan(0);
      expect(maxAbsInt16(mgr.extractLastSeconds('a', 0.02, 5_000_060))).toBe(0);
      // Other channels are not affected.
      expect(mgr.extractLastSeconds('b', 0.02, 5_000_020).length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('costs nothing for a channel that never receives audio', () => {
    const mgr = new ChannelMixRingManager();
    // Reading from an untouched channel must not allocate its ring; that is
    // what makes an idle voice connection free.
    expect(mgr.extractLastSeconds('quiet', 1).length).toBe(0);
    expect(mgr.getTotalMixBufferSizeMB()).toBe(0);
  });
});

/**
 * The ring as it was before page generations and the lookup table: one
 * generation per sample, Math.tanh per output sample. Kept here so the
 * faster ring is held to producing exactly the same bytes.
 */
class ReferenceRing {
  private readonly size: number;
  private readonly mix: Int32Array;
  private readonly generation: Uint16Array;

  constructor(
    seconds: number,
    private readonly epochMs: number
  ) {
    this.size = Math.ceil(48000 * seconds);
    this.mix = new Int32Array(this.size);
    this.generation = new Uint16Array(this.size);
  }

  private generationOf(g: number): number {
    return (Math.floor(g / this.size) % 0xffff) + 1;
  }

  add(pcm: Buffer, endMs: number): void {
    const n = pcm.length >> 1;
    const start = Math.round((endMs - (n / 48000) * 1000 - this.epochMs) * 48);
    for (let j = 0; j < n; j++) {
      const g = start + j;
      if (g < 0) continue;
      const idx = g % this.size;
      const gen = this.generationOf(g);
      if (this.generation[idx] !== gen) {
        this.mix[idx] = 0;
        this.generation[idx] = gen;
      }
      this.mix[idx] += pcm.readInt16LE(j * 2);
    }
  }

  extract(seconds: number, nowMs: number): Buffer {
    const total = Math.min(Math.floor(seconds * 48000), this.size);
    const end = Math.floor((nowMs - this.epochMs) * 48);
    const out = Buffer.allocUnsafe(total * 2);
    for (let j = 0; j < total; j++) {
      const g = end - total + j;
      let v = 0;
      if (g >= 0 && this.generation[g % this.size] === this.generationOf(g)) {
        v = this.mix[g % this.size];
      }
      const s = Math.round(Math.tanh(v / 24000) * 32767);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), j * 2);
    }
    return out;
  }
}

/** Small deterministic PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomPcm(random: () => number, samples: number, scale: number) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round((random() * 2 - 1) * scale), i * 2);
  }
  return buf;
}

describe('ChannelMixRing against the original per-sample ring', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'produces identical bytes for random mixes, laps and windows (seed %i)',
    (seed) => {
      const random = prng(seed);
      const epochMs = 10_000;
      const seconds = 0.1; // 4800 samples: short enough to lap many times
      const ring = new ChannelMixRing(seconds, epochMs);
      const reference = new ReferenceRing(seconds, epochMs);
      let clock = epochMs - 15; // first chunks straddle the epoch

      for (let step = 0; step < 120; step++) {
        clock += 20 + Math.floor(random() * 7) - 3;
        const speakers = 1 + Math.floor(random() * 6);
        for (let s = 0; s < speakers; s++) {
          // Sometimes every speaker is at full scale: sums beyond the
          // lookup table's +/-131072 must still match the formula.
          const scale = random() < 0.2 ? 32767 : 12000;
          const chunk = randomPcm(random, 960, scale);
          const end = clock - Math.floor(random() * 5);
          ring.addMonoPcmInt16(chunk, end);
          reference.add(chunk, end);
        }

        if (step % 7 === 0) {
          const window = random() * 0.12; // includes over-long requests
          expect(ring.extractLastSeconds(window, clock)).toEqual(
            reference.extract(window, clock)
          );
          // A read at exactly the newest write, over the full window.
          expect(ring.extractLastSeconds(seconds, clock)).toEqual(
            reference.extract(seconds, clock)
          );
        }
      }
    }
  );

  it('matches before the epoch, after long silence and across many laps', () => {
    const ring = new ChannelMixRing(0.05, 0);
    const reference = new ReferenceRing(0.05, 0);
    const chunk = randomPcm(prng(9), 960, 30000);

    ring.addMonoPcmInt16(chunk, 30);
    reference.add(chunk, 30);
    for (const now of [-50, 0, 10, 30, 55, 80, 5_000]) {
      expect(ring.extractLastSeconds(0.05, now)).toEqual(
        reference.extract(0.05, now)
      );
    }

    ring.addMonoPcmInt16(chunk, 5_020);
    reference.add(chunk, 5_020);
    expect(ring.extractLastSeconds(0.05, 5_020)).toEqual(
      reference.extract(0.05, 5_020)
    );
  });
});

describe('ChannelMixRing placement', () => {
  it('writes at the exact global sample index it is given', () => {
    const ring = new ChannelMixRing(1, 0);
    ring.addMonoPcmInt16At(constantPcm(10, 9000), 4800); // 100 ms in

    const out = ring.extractLastSeconds(0.2, 200); // samples 0..9599
    const nonSilent: number[] = [];
    for (let i = 0; i < out.length / 2; i++) {
      if (out.readInt16LE(i * 2) !== 0) nonSilent.push(i);
    }
    expect(nonSilent[0]).toBe(4800);
    expect(nonSilent).toHaveLength(10);
  });

  it('places a chunk by receive time the same way as at its computed start', () => {
    const byTime = new ChannelMixRing(1, 0);
    const byIndex = new ChannelMixRing(1, 0);
    const pcm = randomPcm(prng(3), 960, 20000);

    byTime.addMonoPcmInt16(pcm, 333);
    byIndex.addMonoPcmInt16At(pcm, byIndex.globalIndexAt(333) - 960);

    expect(byTime.extractLastSeconds(1, 400)).toEqual(
      byIndex.extractLastSeconds(1, 400)
    );
  });

  it('accepts decoded samples as an Int16Array as well as a Buffer', () => {
    const fromBuffer = new ChannelMixRing(1, 0);
    const fromSamples = new ChannelMixRing(1, 0);
    const pcm = randomPcm(prng(4), 960, 20000);
    const samples = new Int16Array(960);
    for (let i = 0; i < 960; i++) samples[i] = pcm.readInt16LE(i * 2);

    fromBuffer.addMonoPcmInt16At(pcm, 1000);
    fromSamples.addMonoPcmInt16At(samples, 1000);

    expect(fromSamples.extractLastSeconds(1, 500)).toEqual(
      fromBuffer.extractLastSeconds(1, 500)
    );
  });

  it('reads an odd-offset Buffer correctly', () => {
    const ring = new ChannelMixRing(1, 0);
    const backing = Buffer.alloc(960 * 2 + 1);
    const pcm = backing.subarray(1);
    for (let i = 0; i < 960; i++) pcm.writeInt16LE(8000, i * 2);

    ring.addMonoPcmInt16At(pcm, 0);

    expect(minAbsInt16(ring.extractLastSeconds(0.02, 20))).toBeGreaterThan(0);
  });

  it('drops a chunk more than one window older than the newest audio instead of wiping it', () => {
    const ring = new ChannelMixRing(0.1, 0); // 4800-sample window
    ring.addMonoPcmInt16At(constantPcm(960, 8000), 9600);

    // Lands on the same page one lap earlier: must not zero the new audio.
    ring.addMonoPcmInt16At(constantPcm(960, -8000), 9600 - 5760);

    const out = ring.extractLastSeconds(0.02, 220); // samples 9600..10559
    expect(out).toEqual(singleSpeaker(8000));
  });

  it('keeps a chunk that is late but still inside the window', () => {
    const ring = new ChannelMixRing(0.1, 0);
    ring.addMonoPcmInt16At(constantPcm(960, 8000), 9600);
    ring.addMonoPcmInt16At(constantPcm(960, 6000), 9600 - 2880);

    const late = ring
      .extractLastSeconds(0.1, 220)
      .subarray((9600 - 2880 - (10560 - 4800)) * 2);
    expect(late.readInt16LE(0)).toBe(singleSpeaker(6000).readInt16LE(0));
  });

  it('reads a page that was never written as silence', () => {
    const ring = new ChannelMixRing(1, 0);
    ring.addMonoPcmInt16At(constantPcm(960, 8000), 0);

    expect(maxAbsInt16(ring.extractLastSeconds(0.5, 900))).toBe(0);
  });
});

describe('ChannelMixRing.extractLastSecondsAsync', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function busyRing(): ChannelMixRing {
    const ring = new ChannelMixRing(2, 0);
    const random = prng(11);
    for (let end = 20; end <= 2000; end += 20) {
      ring.addMonoPcmInt16(randomPcm(random, 960, 25000), end);
      ring.addMonoPcmInt16(randomPcm(random, 960, 25000), end);
    }
    return ring;
  }

  it('returns the same bytes as the synchronous read', async () => {
    const ring = busyRing();

    const result = await ring.extractLastSecondsAsync(1.5, 2000, {
      stepSamples: 4800,
    });

    expect(result.pcm).toEqual(ring.extractLastSeconds(1.5, 2000));
    expect(result.audible).toBe(true);
  });

  it('lets other work run between steps instead of blocking until done', async () => {
    const ring = busyRing();
    const order: string[] = [];

    const extract = ring
      .extractLastSecondsAsync(2, 2000, { stepSamples: 960 })
      .then(() => order.push('extracted'));
    setImmediate(() => order.push('other work'));
    await extract;

    expect(order).toEqual(['other work', 'extracted']);
  });

  it('reserves zeroed room for a header in front of the audio, in one allocation', async () => {
    const ring = busyRing();

    const { pcm, framed } = await ring.extractLastSecondsAsync(1, 2000, {
      leadingBytes: 44,
    });

    expect(framed.length).toBe(44 + pcm.length);
    expect(framed.buffer).toBe(pcm.buffer);
    expect(framed.subarray(0, 44).every((byte) => byte === 0)).toBe(true);
    expect(framed.subarray(44)).toEqual(ring.extractLastSeconds(1, 2000));
  });

  it.each([
    ['silence', 0, 0, false],
    ['a level that soft-limits to the noise threshold', 35, 48, false],
    ['a level just above it', 36, 49, true],
    ['a negative level just above it', -36, 49, true],
  ])('flags %s correctly', async (_label, level, expectedPeak, audible) => {
    const ring = new ChannelMixRing(1, 0);
    ring.addMonoPcmInt16(constantPcm(960, level), 20);

    const result = await ring.extractLastSecondsAsync(0.02, 20);

    expect(maxAbsInt16(result.pcm)).toBe(expectedPeak);
    expect(result.audible).toBe(audible);
  });
});

describe('ChannelMixRing.getBufferedSeconds', () => {
  it('counts from the first audio up to the window length', () => {
    const ring = new ChannelMixRing(60, 1_000);

    expect(ring.getBufferedSeconds(500)).toBe(0);
    expect(ring.getBufferedSeconds(1_000)).toBe(0);
    expect(ring.getBufferedSeconds(13_500)).toBe(12.5);
    expect(ring.getBufferedSeconds(1_000 + 3_600_000)).toBe(60);
  });

  it('is 0 for a channel the manager never allocated a ring for', () => {
    const mgr = new ChannelMixRingManager();
    expect(mgr.getBufferedSeconds('quiet')).toBe(0);
  });

  it('reads an empty, unallocated channel asynchronously as silence', async () => {
    const mgr = new ChannelMixRingManager();

    const result = await mgr.extractLastSecondsAsync('quiet', 1, undefined, {
      leadingBytes: 44,
    });

    expect(result.pcm.length).toBe(0);
    expect(result.audible).toBe(false);
    expect(result.framed.length).toBe(44);
    expect(mgr.getTotalMixBufferSizeMB()).toBe(0);
  });
});
