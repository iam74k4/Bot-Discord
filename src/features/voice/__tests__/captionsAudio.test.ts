import { describe, expect, it } from 'vitest';
import {
  downsampleTo16k,
  durationMs48k,
  encodeWav,
  rmsDbfs,
} from '../captions/audio.js';
import { extractPcm } from '../tts/wav.js';

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, i * 2));
  return buffer;
}

function samplesOf(buffer: Buffer): number[] {
  return Array.from({ length: buffer.length >> 1 }, (_, i) =>
    buffer.readInt16LE(i * 2)
  );
}

describe('downsampleTo16k', () => {
  it('averages each group of three 48 kHz samples into one', () => {
    expect(samplesOf(downsampleTo16k(pcm([3, 6, 9, -30, 0, 30])))).toEqual([
      6, 0,
    ]);
  });

  it('drops a trailing partial group instead of inventing samples', () => {
    expect(samplesOf(downsampleTo16k(pcm([1, 2, 3, 100, 100])))).toEqual([2]);
  });

  it('keeps full-scale samples within range', () => {
    expect(
      samplesOf(
        downsampleTo16k(pcm([32767, 32767, 32767, -32768, -32768, -32768]))
      )
    ).toEqual([32767, -32768]);
  });
});

describe('rmsDbfs', () => {
  it('reads digital silence as -Infinity', () => {
    expect(rmsDbfs(pcm([0, 0, 0]))).toBe(-Infinity);
    expect(rmsDbfs(Buffer.alloc(0))).toBe(-Infinity);
  });

  it('reads a full-scale square wave as about 0 dBFS', () => {
    expect(rmsDbfs(pcm([32767, -32768, 32767, -32768]))).toBeCloseTo(0, 3);
  });

  it('reads a quarter-scale signal as about -12 dBFS', () => {
    expect(rmsDbfs(pcm([8192, -8192]))).toBeCloseTo(-12.04, 1);
  });
});

describe('encodeWav', () => {
  it('writes a header the TTS WAV reader accepts', () => {
    const body = pcm([1, -1, 2, -2]);
    const wav = encodeWav(body, 16_000);

    expect(wav.length).toBe(44 + body.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    const parsed = extractPcm(wav);
    expect(parsed.sampleRate).toBe(16_000);
    expect(parsed.channels).toBe(1);
    expect(parsed.pcm.equals(body)).toBe(true);
  });
});

describe('durationMs48k', () => {
  it('measures 48 kHz mono 16-bit PCM', () => {
    expect(durationMs48k(Buffer.alloc(48_000 * 2))).toBe(1000);
    expect(durationMs48k(Buffer.alloc(960 * 2))).toBe(20);
  });
});
