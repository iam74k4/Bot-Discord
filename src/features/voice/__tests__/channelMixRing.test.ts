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

  it('reports its memory footprint (int32 mix + uint16 generation per sample)', () => {
    const ring = new ChannelMixRing(10, epoch);

    expect(ring.getApproxSizeMB()).toBeCloseTo(
      (10 * 48000 * (4 + 2)) / (1024 * 1024),
      6
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
    const perRingMB = (60 * 48000 * (4 + 2)) / (1024 * 1024);

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
