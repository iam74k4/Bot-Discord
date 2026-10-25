/**
 * Minimal RIFF/WAVE reader for VOICEVOX output.
 *
 * VOICEVOX returns a complete WAV file. Discord playback wants bare 48 kHz
 * stereo s16le PCM (`StreamType.Raw`), which lets @discordjs/voice encode it
 * with the bundled Opus encoder and avoids depending on an ffmpeg binary.
 */

export interface PcmAudio {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export class InvalidWavError extends Error {
  constructor(reason: string) {
    super(`Invalid WAV data: ${reason}`);
    this.name = 'InvalidWavError';
  }
}

export function extractPcm(wav: Buffer): PcmAudio {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new InvalidWavError('missing RIFF/WAVE header');
  }

  let format: Omit<PcmAudio, 'pcm'> | null = null;
  let offset = 12;

  // Chunks are walked rather than assuming a 44-byte header: encoders are free
  // to insert LIST/fact chunks before the data.
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      if (size < 16 || body + 16 > wav.length) {
        throw new InvalidWavError('truncated fmt chunk');
      }
      const audioFormat = wav.readUInt16LE(body);
      if (audioFormat !== 1) {
        throw new InvalidWavError(`unsupported format ${audioFormat}`);
      }
      format = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) {
        throw new InvalidWavError('data chunk before fmt chunk');
      }
      const end = Math.min(body + size, wav.length);
      return { ...format, pcm: wav.subarray(body, end) };
    }

    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }

  throw new InvalidWavError('no data chunk');
}

/** Bytes per second of 48 kHz stereo 16-bit PCM, the only shape we play. */
export const PLAYBACK_BYTES_PER_SECOND = 48_000 * 2 * 2;

export function playbackDurationMs(pcm: Buffer): number {
  return Math.ceil((pcm.length / PLAYBACK_BYTES_PER_SECOND) * 1000);
}
