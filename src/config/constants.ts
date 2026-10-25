import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version?: string };

/**
 * Internal constants that should NOT be changed via environment variables.
 * These are technical defaults tightly coupled to the audio pipeline,
 * Discord platform limits, and internal monitoring logic.
 *
 * If you need to tune operational parameters (e.g. max recording duration,
 * buffer duration, VC connection limit), use environment variables instead.
 * See env.ts for configurable settings.
 */

/**
 * Audio format constants
 * Changing these breaks WAV file compatibility and existing recordings.
 */
export const AUDIO = {
  /** Sample rate in Hz (48 kHz – matches Discord voice decode; WAV output) */
  SAMPLE_RATE: 48000,
  /** Bit depth (16-bit PCM) */
  BIT_DEPTH: 16,
  /** Channel count (1 = mono) */
  CHANNELS: 1,
} as const;

/**
 * Discord platform limits
 */
export const DISCORD_LIMITS = {
  /**
   * Upload limit assumed when an interaction does not say
   * (`interaction.attachmentSizeLimit` is missing or 0). Real interactions
   * always carry the limit for that server and user, which is authoritative;
   * this conservative value only keeps recordings deliverable without it.
   */
  FALLBACK_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  /**
   * Room kept free under the upload limit for each recording part, so the
   * file plus the request around it never brushes against the limit.
   */
  UPLOAD_HEADROOM_BYTES: 64 * 1024,
} as const;

/**
 * Internal retry / resilience defaults
 */
export const RETRY = {
  /** Maximum retry count for recording file upload */
  RECORDING_RETRY_MAX: 3,
} as const;

/**
 * Memory and disk monitoring thresholds
 */
/**
 * Bot metadata
 */
export const BOT_INFO = {
  NAME: 'Discord Bot',
  VERSION: pkg?.version ?? '1.0.0',
} as const;

export const MONITORING = {
  /** Memory monitor check interval in ms (1 minute) */
  MEMORY_MONITOR_INTERVAL_MS: 60_000,
} as const;
