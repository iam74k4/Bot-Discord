import { AUDIO } from '../../../config/constants.js';
import { env } from '../../../config/index.js';

/** Discord voice decode path: 48 kHz mono int16 LE into the mix ring. */
const SAMPLE_RATE = AUDIO.SAMPLE_RATE;

/**
 * Wall-clock–aligned ring buffer: multiple users' PCM is summed per sample with
 * slot ownership to handle ring wrap. Output uses soft limiting.
 */
/**
 * Sentinel stored in `slotGeneration` for a slot that was never written.
 * Generations are stored as `(lap % GENERATION_MODULUS) + 1` so 0 stays free.
 */
const GENERATION_MODULUS = 0xffff;

export class ChannelMixRing {
  private readonly sizeSamples: number;
  /**
   * Per-sample sum of every speaker. Int32 (not Float32): the mix is a sum of
   * int16 samples, so it needs no fraction, and 4 bytes still leaves room for
   * more concurrent speakers than a voice channel can hold.
   */
  private readonly mix: Int32Array;
  /**
   * Which lap around the ring last wrote each slot, +1 so that 0 means empty.
   * Storing the lap rather than the global sample index keeps this at 2 bytes
   * instead of 8; a stale slot is only misread if it survives 65535 laps
   * untouched (weeks at any sane buffer length).
   */
  private readonly slotGeneration: Uint16Array;
  /**
   * Start of this ring's timeline. Fixed at construction: a ring lives for one
   * voice session, so there is never a reason to move it. Anything before the
   * epoch reads as silence.
   */
  private readonly epochMs: number;

  constructor(bufferDurationSeconds: number, epochMs: number = Date.now()) {
    this.sizeSamples = Math.ceil(SAMPLE_RATE * bufferDurationSeconds);
    this.mix = new Int32Array(this.sizeSamples);
    this.slotGeneration = new Uint16Array(this.sizeSamples);
    this.epochMs = epochMs;
  }

  /** Lap marker for a global sample index (never 0, which means "empty"). */
  private generationOf(globalIndex: number): number {
    const lap = Math.floor(globalIndex / this.sizeSamples);
    return (lap % GENERATION_MODULUS) + 1;
  }

  /**
   * Mix mono s16le PCM into the ring. `endWallMs` is receive time (chunk end).
   */
  addMonoPcmInt16(pcm: Buffer, endWallMs: number): void {
    const n = pcm.length >> 1;
    if (n <= 0) return;

    const durationMs = (n / SAMPLE_RATE) * 1000;
    const startWallMs = endWallMs - durationMs;
    const startGlobal = Math.round(
      (startWallMs - this.epochMs) * (SAMPLE_RATE / 1000)
    );

    for (let j = 0; j < n; j++) {
      const g = startGlobal + j;
      if (g < 0) continue;

      const idx = g % this.sizeSamples;
      const generation = this.generationOf(g);
      if (this.slotGeneration[idx] !== generation) {
        this.mix[idx] = 0;
        this.slotGeneration[idx] = generation;
      }

      this.mix[idx] += pcm.readInt16LE(j * 2);
    }
  }

  /**
   * Read the last `seconds` of mixed audio as s16le mono (includes silence).
   */
  extractLastSeconds(seconds: number, nowMs = Date.now()): Buffer {
    const totalSamples = Math.min(
      Math.floor(seconds * SAMPLE_RATE),
      this.sizeSamples
    );
    const endGlobal = Math.floor((nowMs - this.epochMs) * (SAMPLE_RATE / 1000));
    const startGlobal = endGlobal - totalSamples;
    const out = Buffer.allocUnsafe(totalSamples * 2);

    for (let j = 0; j < totalSamples; j++) {
      const g = startGlobal + j;
      let v = 0;
      if (g >= 0) {
        const idx = g % this.sizeSamples;
        if (this.slotGeneration[idx] === this.generationOf(g)) {
          v = this.mix[idx];
        }
      }

      const soft = softLimitToInt16(v);
      out.writeInt16LE(soft, j * 2);
    }

    return out;
  }

  getApproxSizeMB(): number {
    return (
      (this.mix.byteLength + this.slotGeneration.byteLength) / (1024 * 1024)
    );
  }
}

/**
 * Map float mix sum to int16 with gentle saturation (multi-speaker headroom).
 */
function softLimitToInt16(v: number): number {
  const t = Math.tanh(v / 24000);
  const s = Math.round(t * 32767);
  return Math.max(-32768, Math.min(32767, s));
}

/**
 * Per-channel time-aligned mix rings (one per voice channel id).
 */
export class ChannelMixRingManager {
  private readonly rings = new Map<string, ChannelMixRing>();

  /**
   * Return this channel's ring, allocating it on first use.
   *
   * Allocation is the expensive step (~0.27 MB per buffered second), so
   * callers are expected to reach here only when there is audio to store —
   * an idle voice channel then holds no buffer at all.
   */
  getOrCreate(channelId: string): ChannelMixRing {
    let ring = this.rings.get(channelId);
    if (!ring) {
      ring = new ChannelMixRing(env.AUDIO_BUFFER_DURATION);
      this.rings.set(channelId, ring);
    }
    return ring;
  }

  remove(channelId: string): void {
    this.rings.delete(channelId);
  }

  /** Whether this channel holds a ring, i.e. has buffered any audio. */
  has(channelId: string): boolean {
    return this.rings.has(channelId);
  }

  extractLastSeconds(
    channelId: string,
    seconds: number,
    nowMs?: number
  ): Buffer {
    const ring = this.rings.get(channelId);
    if (!ring) {
      return Buffer.alloc(0);
    }
    return ring.extractLastSeconds(seconds, nowMs);
  }

  getTotalMixBufferSizeMB(): number {
    let sum = 0;
    for (const ring of this.rings.values()) {
      sum += ring.getApproxSizeMB();
    }
    return sum;
  }
}

export const channelMixRingManager = new ChannelMixRingManager();
