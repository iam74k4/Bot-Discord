import { durationMs48k, INPUT_SAMPLE_RATE } from './audio.js';

/**
 * Cuts one speaker's stream of decoded audio into utterances to transcribe.
 *
 * Discord sends no packets while someone is silent, so the receive stream
 * ending (after a short silence) is the natural end of an utterance. A long
 * monologue is cut at `maxMs` anyway, so its captions do not wait for the
 * speaker to stop; very short bursts (a cough, a key click) are dropped.
 */

export interface Utterance {
  userId: string;
  /** 48 kHz mono 16-bit PCM. */
  pcm: Buffer;
  /** Wall-clock time the first chunk arrived. */
  startedAt: number;
}

export interface UtteranceLimits {
  /** Shorter utterances are dropped (ms). */
  minMs: number;
  /** Longer speech is cut into pieces of at most this length (ms). */
  maxMs: number;
}

export const DEFAULT_UTTERANCE_LIMITS: UtteranceLimits = {
  minMs: 400,
  maxMs: 15_000,
};

export class UtteranceCollector {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private startedAt = 0;
  private readonly maxBytes: number;

  constructor(
    private readonly userId: string,
    private readonly emit: (utterance: Utterance) => void,
    private readonly limits: UtteranceLimits = DEFAULT_UTTERANCE_LIMITS
  ) {
    this.maxBytes = Math.floor((limits.maxMs / 1000) * INPUT_SAMPLE_RATE) * 2;
  }

  push(chunk: Buffer, now: number): void {
    if (this.bytes === 0) this.startedAt = now;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes >= this.maxBytes) this.cut();
  }

  /** The speaker's stream ended: whatever is buffered is one utterance. */
  end(): void {
    this.cut();
  }

  private cut(): void {
    if (this.bytes === 0) return;
    const pcm = Buffer.concat(this.chunks, this.bytes);
    const startedAt = this.startedAt;
    this.chunks = [];
    this.bytes = 0;
    if (durationMs48k(pcm) < this.limits.minMs) return;
    this.emit({ userId: this.userId, pcm, startedAt });
  }
}
