/**
 * Audio helpers for captions: Discord hands the bot 48 kHz mono 16-bit PCM
 * per speaker; Whisper wants 16 kHz. Resampling here keeps the engine choice
 * open (whisper.cpp's server does not resample unless built with ffmpeg) and
 * sends a third of the bytes.
 */

export const INPUT_SAMPLE_RATE = 48_000;
export const WHISPER_SAMPLE_RATE = 16_000;
const DECIMATION = INPUT_SAMPLE_RATE / WHISPER_SAMPLE_RATE;

/**
 * 48 kHz → 16 kHz by averaging each group of three samples. The average is a
 * crude low-pass filter, but speech carries next to nothing above the new
 * 8 kHz Nyquist limit, so it is enough to keep aliasing out of the
 * recognizer's way.
 */
export function downsampleTo16k(pcm48k: Buffer): Buffer {
  const inputSamples = pcm48k.length >> 1;
  const outputSamples = Math.floor(inputSamples / DECIMATION);
  const out = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i++) {
    const base = i * DECIMATION * 2;
    const sum =
      pcm48k.readInt16LE(base) +
      pcm48k.readInt16LE(base + 2) +
      pcm48k.readInt16LE(base + 4);
    out.writeInt16LE(Math.round(sum / DECIMATION), i * 2);
  }
  return out;
}

/**
 * Loudness of 16-bit PCM as dBFS (0 is full scale; silence is -Infinity).
 * Used to skip near-silent utterances before they reach Whisper, which turns
 * silence into confident nonsense.
 */
export function rmsDbfs(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return -Infinity;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/** Wrap mono 16-bit PCM in a minimal RIFF/WAVE header. */
export function encodeWav(
  pcm: Buffer,
  sampleRate: number = WHISPER_SAMPLE_RATE
): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Duration of 48 kHz mono 16-bit PCM in milliseconds. */
export function durationMs48k(pcm: Buffer): number {
  return ((pcm.length >> 1) / INPUT_SAMPLE_RATE) * 1000;
}
