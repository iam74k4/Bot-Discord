import { randomBytes } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { env, AUDIO, DISCORD_LIMITS } from '../../../config/index.js';
import {
  AUDIBLE_THRESHOLD,
  channelMixRingManager,
  toInt16Samples,
} from './channelMixRing.js';
import {
  RecordingOptions,
  RecordingPart,
  RecordingResult,
} from '../../../shared/types/voice.js';

/** Size of the canonical PCM WAV header written in front of every part. */
export const WAV_HEADER_BYTES = 44;

/**
 * Parts are cut on 20 ms frame boundaries (960 samples of 16-bit mono), which
 * also keeps every part a whole number of samples.
 */
const PART_ALIGN_BYTES =
  ((AUDIO.SAMPLE_RATE / 50) * AUDIO.BIT_DEPTH * AUDIO.CHANNELS) / 8;

/** Bytes of PCM per second of audio. */
const BYTES_PER_SECOND =
  (AUDIO.SAMPLE_RATE * AUDIO.BIT_DEPTH * AUDIO.CHANNELS) / 8;

/**
 * Recording queue per channel.
 * Entries are removed as soon as the recording completes.
 */
const recordingQueues = new Map<string, Promise<RecordingResult>>();

/**
 * Write a canonical PCM WAV header for `dataSize` bytes into the first 44
 * bytes of `target`.
 */
function writeWavHeader(target: Buffer, dataSize: number): void {
  const sampleRate = AUDIO.SAMPLE_RATE;
  const bitDepth = AUDIO.BIT_DEPTH;
  const channels = AUDIO.CHANNELS;
  const byteRate = (sampleRate * bitDepth * channels) / 8;
  const blockAlign = (bitDepth * channels) / 8;

  let offset = 0;

  // RIFF header
  target.write('RIFF', offset);
  offset += 4;
  target.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  target.write('WAVE', offset);
  offset += 4;

  // fmt chunk
  target.write('fmt ', offset);
  offset += 4;
  target.writeUInt32LE(16, offset); // fmt chunk size
  offset += 4;
  target.writeUInt16LE(1, offset); // audio format (PCM)
  offset += 2;
  target.writeUInt16LE(channels, offset);
  offset += 2;
  target.writeUInt32LE(sampleRate, offset);
  offset += 4;
  target.writeUInt32LE(byteRate, offset);
  offset += 4;
  target.writeUInt16LE(blockAlign, offset);
  offset += 2;
  target.writeUInt16LE(bitDepth, offset);
  offset += 2;

  // data chunk
  target.write('data', offset);
  offset += 4;
  target.writeUInt32LE(dataSize, offset);
}

/**
 * Thrown when the mix window has no samples above the noise threshold.
 */
export class RecordingNoAudibleAudioError extends Error {
  override readonly name = 'RecordingNoAudibleAudioError';

  /**
   * @param checkedSeconds how much audio was actually looked at: less than
   *   requested when the bot had not been hearing the channel that long (0
   *   when it had heard nothing at all). Undefined when unknown.
   */
  constructor(readonly checkedSeconds?: number) {
    super(
      'No audible audio in the recording window. Make sure someone is speaking in the voice channel.'
    );
  }
}

/**
 * Thrown when another recording of the same channel is still being written.
 * It is short-lived (the slot frees as soon as the files are on disk), so
 * the caller can simply ask the user to try again in a few seconds.
 */
export class RecordingInProgressError extends Error {
  override readonly name = 'RecordingInProgressError';

  constructor() {
    super('Recording already in progress for this channel');
  }
}

/**
 * True if buffer has any sample above a small noise threshold.
 */
export function pcmBufferHasAudibleSignal(
  buf: Buffer,
  threshold = AUDIBLE_THRESHOLD
): boolean {
  const samples = toInt16Samples(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if ((s < 0 ? -s : s) > threshold) {
      return true;
    }
  }
  return false;
}

/** Byte range of one part inside the PCM. */
interface PartRange {
  offset: number;
  length: number;
}

/**
 * Cut `pcmBytes` into the fewest parts whose WAV files stay under
 * `maxFileBytes` (minus headroom), as equal as frame alignment allows: a
 * 5-minute clip on a 10 MiB server becomes three parts of about 1m40s
 * rather than two full ones and a stub.
 */
export function planRecordingParts(
  pcmBytes: number,
  maxFileBytes: number
): PartRange[] {
  const budget = maxFileBytes - DISCORD_LIMITS.UPLOAD_HEADROOM_BYTES;
  if (WAV_HEADER_BYTES + pcmBytes <= budget) {
    return [{ offset: 0, length: pcmBytes }];
  }

  const maxData = Math.max(
    PART_ALIGN_BYTES,
    Math.floor((budget - WAV_HEADER_BYTES) / PART_ALIGN_BYTES) *
      PART_ALIGN_BYTES
  );
  const count = Math.ceil(pcmBytes / maxData);
  const partBytes =
    Math.ceil(pcmBytes / count / PART_ALIGN_BYTES) * PART_ALIGN_BYTES;

  const parts: PartRange[] = [];
  for (let offset = 0; offset < pcmBytes; offset += partBytes) {
    parts.push({ offset, length: Math.min(partBytes, pcmBytes - offset) });
  }
  return parts;
}

/**
 * Generate a unique file name for a recording.
 * Includes channel id + nonce so concurrent recordings on different
 * channels in the same second cannot overwrite each other.
 */
export function generateFileName(duration: number, channelId: string): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, '').replace(/\./g, '-');
  const durationStr = `${duration}s`;
  const safeChannelId = channelId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const nonce = randomBytes(4).toString('hex');
  return `recording_${dateStr}_${durationStr}_${safeChannelId}_${nonce}.wav`;
}

/** `recording_..._abcd1234.wav` -> `recording_..._abcd1234_part2.wav`. */
function partFileName(baseName: string, part: number): string {
  return baseName.replace(/\.wav$/, `_part${part}.wav`);
}

/**
 * Record audio from the channel time-aligned mix ring.
 */
export async function recordAudio(
  options: RecordingOptions
): Promise<RecordingResult> {
  const { channelId, duration } = options;

  if (recordingQueues.has(channelId)) {
    throw new RecordingInProgressError();
  }

  if (duration <= 0) {
    throw new Error('Duration must be greater than 0');
  }

  if (duration > env.MAX_RECORDING_DURATION) {
    throw new Error(
      `Duration exceeds maximum (${env.MAX_RECORDING_DURATION}s)`
    );
  }

  if (duration > env.AUDIO_BUFFER_DURATION) {
    throw new Error(
      `Duration exceeds buffer duration (${env.AUDIO_BUFFER_DURATION}s)`
    );
  }

  const maxUploadBytes =
    options.maxUploadBytes && options.maxUploadBytes > 0
      ? options.maxUploadBytes
      : DISCORD_LIMITS.FALLBACK_ATTACHMENT_BYTES;

  // Defer work so the queue entry is registered before any sync throw
  // (e.g. RecordingNoAudibleAudioError). Otherwise finally runs before
  // set() and the rejected promise stays forever, blocking the channel.
  const recordingPromise = Promise.resolve().then(async () => {
    try {
      // Audio from before the bot started hearing this channel does not
      // exist; asking for it would only pad the clip with silence.
      const buffered = channelMixRingManager.getBufferedSeconds(channelId);
      const saved = Math.min(duration, Math.ceil(buffered));
      if (saved <= 0) {
        throw new RecordingNoAudibleAudioError(0);
      }

      const { pcm, audible, framed } =
        await channelMixRingManager.extractLastSecondsAsync(
          channelId,
          saved,
          undefined,
          { leadingBytes: WAV_HEADER_BYTES }
        );

      if (pcm.length === 0 || !audible) {
        throw new RecordingNoAudibleAudioError(saved);
      }

      const recordingsDir = join(process.cwd(), env.RECORDINGS_DIR);
      await mkdir(recordingsDir, { recursive: true });

      const ranges = planRecordingParts(pcm.length, maxUploadBytes);
      const isSplit = ranges.length > 1;
      // One name for the whole recording, so every part shares its
      // timestamp and nonce and only the `_partN` suffix differs.
      const baseName = generateFileName(saved, channelId);
      const parts: RecordingPart[] = [];

      for (const [index, range] of ranges.entries()) {
        let data: Buffer;
        if (index === 0) {
          // The extract left room for the header in front of the audio.
          data = framed.subarray(0, WAV_HEADER_BYTES + range.length);
        } else {
          // Later parts are copied once, behind their own header: on a
          // 3-part split that holds about two thirds of the audio twice
          // until the upload ends. Reserving a gap before every part inside
          // the extract would avoid it (a follow-up).
          data = Buffer.allocUnsafe(WAV_HEADER_BYTES + range.length);
          pcm.copy(
            data,
            WAV_HEADER_BYTES,
            range.offset,
            range.offset + range.length
          );
        }
        writeWavHeader(data, range.length);

        const filePath = join(
          recordingsDir,
          isSplit ? partFileName(baseName, index + 1) : baseName
        );
        await writeFile(filePath, data);

        parts.push({
          filePath,
          size: data.length,
          data,
          startSeconds: range.offset / BYTES_PER_SECOND,
          endSeconds: (range.offset + range.length) / BYTES_PER_SECOND,
        });
      }

      return {
        filePath: parts[0].filePath,
        fileSize: parts.reduce((sum, part) => sum + part.size, 0),
        duration: saved,
        requestedDuration: duration,
        isSplit,
        ...(isSplit
          ? { additionalFiles: parts.slice(1).map((part) => part.filePath) }
          : {}),
        parts,
      };
    } finally {
      if (recordingQueues.get(channelId) === recordingPromise) {
        recordingQueues.delete(channelId);
      }
    }
  });

  recordingQueues.set(channelId, recordingPromise);

  return recordingPromise;
}

/**
 * Parse a human-readable duration string (e.g. "30s", "1m", "5m") to seconds.
 */
export function parseDurationString(durationStr: string): number {
  const match = durationStr.match(/^(\d+)([smh])$/i);
  if (!match) {
    throw new Error('Invalid duration format');
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    default:
      throw new Error('Invalid duration unit');
  }
}
