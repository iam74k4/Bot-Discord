import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { AUDIO } from '../../../config/constants.js';
import { env } from '../../../config/index.js';

/** Discord voice decode path: 48 kHz mono int16 LE into the mix ring. */
const SAMPLE_RATE = AUDIO.SAMPLE_RATE;

/**
 * One page is one 20 ms Opus frame. Lap bookkeeping is kept per page rather
 * than per sample: a page is cleared the first time a new lap writes to it,
 * which costs one marker per 960 samples instead of one per sample.
 */
export const PAGE_SAMPLES = 960;

/**
 * Generations are stored as `(lap % GENERATION_MODULUS) + 1` so 0 stays free
 * for "never written".
 */
const GENERATION_MODULUS = 0xffff;

/** Samples no louder than this (absolute) count as silence. */
export const AUDIBLE_THRESHOLD = 48;

/**
 * How much audio an asynchronous extract copies between yields. Five seconds
 * take a few milliseconds, so voice receive and interactions are never held
 * up for longer than that while a 5-minute clip is exported.
 */
const EXTRACT_STEP_SAMPLES = 5 * SAMPLE_RATE;

/** Typed-array views write in host byte order; WAV wants little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Map a mix sum to int16 with gentle saturation (multi-speaker headroom):
 * `round(tanh(v / 24000) * 32767)`.
 */
export function softLimitToInt16(v: number): number {
  const t = Math.tanh(v / 24000);
  const s = Math.round(t * 32767);
  return Math.max(-32768, Math.min(32767, s));
}

/**
 * Sums within +/-131072 (four full-scale speakers) are looked up instead of
 * calling Math.tanh per sample, which made a 5-minute export block the event
 * loop for most of a second. Values outside the table use the formula.
 */
const SOFT_LIMIT_TABLE_RANGE = 131072;
let softLimitTable: Int16Array | null = null;

/** Built on first use (512 KiB), never at import time. */
function getSoftLimitTable(): Int16Array {
  if (!softLimitTable) {
    const table = new Int16Array(SOFT_LIMIT_TABLE_RANGE * 2 + 1);
    for (let v = -SOFT_LIMIT_TABLE_RANGE; v <= SOFT_LIMIT_TABLE_RANGE; v++) {
      table[v + SOFT_LIMIT_TABLE_RANGE] = softLimitToInt16(v);
    }
    softLimitTable = table;
  }
  return softLimitTable;
}

/** Decoded PCM as int16 samples, without copying when the bytes allow it. */
export function toInt16Samples(pcm: Buffer | Int16Array): Int16Array {
  if (pcm instanceof Int16Array) return pcm;
  const n = pcm.length >> 1;
  if (LITTLE_ENDIAN && pcm.byteOffset % 2 === 0) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, n);
  }
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** An extracted window and whether anything in it is above the noise floor. */
export interface ExtractResult {
  /** s16le mono PCM, silence included. */
  pcm: Buffer;
  /** True when at least one sample exceeds `AUDIBLE_THRESHOLD`. */
  audible: boolean;
  /**
   * `pcm` with the requested `leadingBytes` of zeroed room in front of it,
   * in the same allocation: a WAV header can be written there without
   * copying the audio.
   */
  framed: Buffer;
}

export interface AsyncExtractOptions {
  /** Samples copied between yields (default: 5 seconds). */
  stepSamples?: number;
  /** Zeroed bytes to reserve in front of the PCM (even; default 0). */
  leadingBytes?: number;
}

/** Output buffer plus a native-order view to fill it through. */
function allocateOutput(
  totalSamples: number,
  leadingBytes = 0
): { framed: Buffer; pcm: Buffer; samples: Int16Array } {
  // Zero-filled: stretches with no audio are silence without being touched.
  const framed = Buffer.alloc(leadingBytes + totalSamples * 2);
  const pcm = framed.subarray(leadingBytes);
  const samples =
    LITTLE_ENDIAN && pcm.byteOffset % 2 === 0
      ? new Int16Array(pcm.buffer, pcm.byteOffset, totalSamples)
      : new Int16Array(totalSamples);
  return { framed, pcm, samples };
}

/** Copy a detached sample array into the output (big-endian hosts only). */
function finishOutput(pcm: Buffer, samples: Int16Array): Buffer {
  if (samples.buffer !== pcm.buffer) {
    for (let i = 0; i < samples.length; i++) {
      pcm.writeInt16LE(samples[i], i * 2);
    }
  }
  return pcm;
}

/**
 * Wall-clock–aligned ring buffer: multiple users' PCM is summed per sample
 * and read back through a soft limiter.
 *
 * Storage is one page (20 ms) longer than the window it promises, so an
 * extract of the full window never races the newest write for its oldest
 * page.
 */
export class ChannelMixRing {
  /** Samples a caller can read back (the configured buffer length). */
  private readonly windowSamples: number;
  /** Physical ring length: whole pages, one more than the window needs. */
  private readonly sizeSamples: number;
  /**
   * Per-sample sum of every speaker. Int32 (not Float32): the mix is a sum of
   * int16 samples, so it needs no fraction, and 4 bytes still leaves room for
   * more concurrent speakers than a voice channel can hold.
   */
  private readonly mix: Int32Array;
  /**
   * Which lap around the ring last wrote each page, +1 so that 0 means never
   * written. A stale page is only misread if it survives 65535 laps
   * untouched (weeks at any sane buffer length).
   */
  private readonly pageGeneration: Uint16Array;
  /**
   * Start of this ring's timeline. Fixed at construction: a ring lives for one
   * voice session, so there is never a reason to move it. Anything before the
   * epoch reads as silence.
   */
  private readonly epochMs: number;
  /** One past the newest global sample written so far. */
  private newestEnd = 0;

  constructor(bufferDurationSeconds: number, epochMs: number = Date.now()) {
    this.windowSamples = Math.ceil(SAMPLE_RATE * bufferDurationSeconds);
    const pages = Math.ceil(this.windowSamples / PAGE_SAMPLES) + 1;
    this.sizeSamples = pages * PAGE_SAMPLES;
    this.mix = new Int32Array(this.sizeSamples);
    this.pageGeneration = new Uint16Array(pages);
    this.epochMs = epochMs;
  }

  /** Lap marker for a global sample index (never 0, which means "empty"). */
  private generationOf(globalIndex: number): number {
    const lap = Math.floor(globalIndex / this.sizeSamples);
    return (lap % GENERATION_MODULUS) + 1;
  }

  /** Global sample index of a wall-clock instant on this ring's timeline. */
  globalIndexAt(wallMs: number): number {
    return Math.round((wallMs - this.epochMs) * (SAMPLE_RATE / 1000));
  }

  /**
   * Mix mono s16le PCM into the ring. `endWallMs` is receive time (chunk end).
   */
  addMonoPcmInt16(pcm: Buffer | Int16Array, endWallMs: number): void {
    const samples = toInt16Samples(pcm);
    this.addMonoPcmInt16At(
      samples,
      this.globalIndexAt(endWallMs) - samples.length
    );
  }

  /**
   * Mix mono PCM into the ring starting at an exact global sample index.
   * Samples before the epoch, and samples more than one window older than
   * the newest audio, are dropped: writing them would wipe newer audio that
   * shares their page.
   */
  addMonoPcmInt16At(pcm: Buffer | Int16Array, startGlobal: number): void {
    const samples = toInt16Samples(pcm);
    const n = samples.length;
    if (n === 0) return;

    const oldestKept = Math.max(0, this.newestEnd - this.windowSamples);
    const size = this.sizeSamples;
    const mix = this.mix;
    let j = Math.max(0, oldestKept - startGlobal);

    while (j < n) {
      const g = startGlobal + j;
      const idx = g % size;
      const page = (idx / PAGE_SAMPLES) | 0;
      const pageEnd = (page + 1) * PAGE_SAMPLES;
      const generation = this.generationOf(g);
      if (this.pageGeneration[page] !== generation) {
        mix.fill(0, page * PAGE_SAMPLES, pageEnd);
        this.pageGeneration[page] = generation;
      }
      const runEnd = Math.min(n, j + (pageEnd - idx));
      for (let k = idx; j < runEnd; j++, k++) {
        mix[k] += samples[j];
      }
    }

    this.newestEnd = Math.max(this.newestEnd, startGlobal + n);
  }

  /** The samples a read of `seconds` ending at `nowMs` covers. */
  private windowFor(
    seconds: number,
    nowMs: number
  ): { start: number; total: number } {
    const total = Math.max(
      0,
      Math.min(Math.floor(seconds * SAMPLE_RATE), this.windowSamples)
    );
    const end = Math.floor((nowMs - this.epochMs) * (SAMPLE_RATE / 1000));
    return { start: end - total, total };
  }

  /**
   * Soft-limit window samples `[from, to)` into `out`.
   * @returns the largest absolute output sample
   */
  private fillRange(
    out: Int16Array,
    windowStart: number,
    from: number,
    to: number
  ): number {
    const table = getSoftLimitTable();
    const size = this.sizeSamples;
    const mix = this.mix;
    let peak = 0;
    let j = from;

    while (j < to) {
      const g = windowStart + j;
      if (g < 0) {
        // Before the epoch: silence, which the output already holds.
        j = Math.min(to, -windowStart);
        continue;
      }
      const idx = g % size;
      const page = (idx / PAGE_SAMPLES) | 0;
      const runEnd = Math.min(to, j + ((page + 1) * PAGE_SAMPLES - idx));
      if (this.pageGeneration[page] !== this.generationOf(g)) {
        j = runEnd;
        continue;
      }
      for (let k = idx; j < runEnd; j++, k++) {
        const v = mix[k];
        const s =
          v >= -SOFT_LIMIT_TABLE_RANGE && v <= SOFT_LIMIT_TABLE_RANGE
            ? table[v + SOFT_LIMIT_TABLE_RANGE]
            : softLimitToInt16(v);
        out[j] = s;
        const magnitude = s < 0 ? -s : s;
        if (magnitude > peak) peak = magnitude;
      }
    }

    return peak;
  }

  /**
   * Read the last `seconds` of mixed audio as s16le mono (includes silence).
   * Synchronous; long windows should use `extractLastSecondsAsync`.
   */
  extractLastSeconds(seconds: number, nowMs = Date.now()): Buffer {
    const { start, total } = this.windowFor(seconds, nowMs);
    const { pcm, samples } = allocateOutput(total);
    this.fillRange(samples, start, 0, total);
    return finishOutput(pcm, samples);
  }

  /**
   * Same output as `extractLastSeconds`, copied a few seconds at a time with
   * a yield in between, so a 5-minute export does not stall voice receive or
   * interactions. The window is fixed before the first copy and filled
   * oldest first: audio arriving meanwhile can only reuse pages at the
   * oldest edge, which have already been copied.
   */
  async extractLastSecondsAsync(
    seconds: number,
    nowMs = Date.now(),
    options: AsyncExtractOptions = {}
  ): Promise<ExtractResult> {
    const { start, total } = this.windowFor(seconds, nowMs);
    const { framed, pcm, samples } = allocateOutput(
      total,
      options.leadingBytes ?? 0
    );
    const step = Math.max(
      PAGE_SAMPLES,
      Math.floor(options.stepSamples ?? EXTRACT_STEP_SAMPLES)
    );
    let peak = 0;

    for (let from = 0; from < total; from += step) {
      if (from > 0) await yieldToEventLoop();
      const to = Math.min(total, from + step);
      peak = Math.max(peak, this.fillRange(samples, start, from, to));
    }

    return {
      pcm: finishOutput(pcm, samples),
      audible: peak > AUDIBLE_THRESHOLD,
      framed,
    };
  }

  /**
   * Seconds of audio this ring can actually hold right now: from the first
   * received audio (the epoch) up to the window length. Asking for more only
   * pads the clip with silence from before the bot heard anything.
   */
  getBufferedSeconds(nowMs = Date.now()): number {
    return Math.min(
      this.windowSamples / SAMPLE_RATE,
      Math.max(0, (nowMs - this.epochMs) / 1000)
    );
  }

  getApproxSizeMB(): number {
    return (
      (this.mix.byteLength + this.pageGeneration.byteLength) / (1024 * 1024)
    );
  }
}

/**
 * Per-channel time-aligned mix rings (one per voice channel id).
 */
export class ChannelMixRingManager {
  private readonly rings = new Map<string, ChannelMixRing>();

  /**
   * Return this channel's ring, allocating it on first use.
   *
   * Allocation is the expensive step (~0.18 MB per buffered second), so
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

  async extractLastSecondsAsync(
    channelId: string,
    seconds: number,
    nowMs?: number,
    options?: AsyncExtractOptions
  ): Promise<ExtractResult> {
    const ring = this.rings.get(channelId);
    if (!ring) {
      const framed = Buffer.alloc(options?.leadingBytes ?? 0);
      return { pcm: framed.subarray(framed.length), audible: false, framed };
    }
    return ring.extractLastSecondsAsync(seconds, nowMs, options);
  }

  /** 0 when the channel has no ring: nothing has been heard there yet. */
  getBufferedSeconds(channelId: string, nowMs?: number): number {
    return this.rings.get(channelId)?.getBufferedSeconds(nowMs) ?? 0;
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
