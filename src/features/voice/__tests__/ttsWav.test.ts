import { describe, expect, it } from 'vitest';
import {
  extractPcm,
  InvalidWavError,
  PLAYBACK_BYTES_PER_SECOND,
  playbackDurationMs,
} from '../tts/wav.js';

/** One RIFF chunk: 4-byte id, little-endian size, body, pad byte if odd. */
function chunk(id: string, body: Buffer, declaredSize = body.length): Buffer {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(declaredSize, 4);
  const pad = body.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([header, body, pad]);
}

function fmtBody({
  format = 1,
  channels = 2,
  sampleRate = 48_000,
  bitsPerSample = 16,
}: Partial<{
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}> = {}): Buffer {
  const body = Buffer.alloc(16);
  const blockAlign = (channels * bitsPerSample) / 8;
  body.writeUInt16LE(format, 0);
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE(sampleRate * blockAlign, 8);
  body.writeUInt16LE(blockAlign, 12);
  body.writeUInt16LE(bitsPerSample, 14);
  return body;
}

function riff(...chunks: Buffer[]): Buffer {
  const content = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(content.length + 4, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, content]);
}

const PCM = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

describe('extractPcm', () => {
  it('reads a canonical 44-byte-header file', () => {
    const wav = riff(chunk('fmt ', fmtBody()), chunk('data', PCM));
    expect(wav.length).toBe(44 + PCM.length);

    const audio = extractPcm(wav);
    expect(audio).toEqual({
      pcm: PCM,
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
    });
  });

  it('reports the format it found rather than assuming 48 kHz stereo', () => {
    const audio = extractPcm(
      riff(
        chunk('fmt ', fmtBody({ channels: 1, sampleRate: 24_000 })),
        chunk('data', PCM)
      )
    );
    expect(audio.channels).toBe(1);
    expect(audio.sampleRate).toBe(24_000);
    expect(audio.bitsPerSample).toBe(16);
  });

  it('accepts a fmt chunk longer than 16 bytes', () => {
    const extended = Buffer.concat([fmtBody(), Buffer.from([0, 0])]);
    const audio = extractPcm(riff(chunk('fmt ', extended), chunk('data', PCM)));
    expect(audio.pcm).toEqual(PCM);
  });

  it('skips LIST and other chunks before data', () => {
    const list = chunk('LIST', Buffer.from('INFOISFT\x04\x00\x00\x00test'));
    const fact = chunk('fact', Buffer.from([0, 0, 0, 0]));
    const audio = extractPcm(
      riff(list, chunk('fmt ', fmtBody()), fact, chunk('data', PCM))
    );
    expect(audio.pcm).toEqual(PCM);
  });

  it('honours the pad byte after an odd-sized chunk', () => {
    // A 3-byte chunk is followed by one pad byte; reading without it would
    // land one byte short of the next chunk id.
    const odd = chunk('junk', Buffer.from([9, 9, 9]));
    expect(odd.length).toBe(8 + 3 + 1);
    const audio = extractPcm(
      riff(chunk('fmt ', fmtBody()), odd, chunk('data', PCM))
    );
    expect(audio.pcm).toEqual(PCM);
  });

  it('clamps a data chunk that declares more bytes than exist', () => {
    const header = riff(chunk('fmt ', fmtBody()));
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeUInt32LE(1_000_000, 4);
    const audio = extractPcm(Buffer.concat([header, dataHeader, PCM]));
    expect(audio.pcm).toEqual(PCM);
  });

  it('returns a view of the input rather than a copy', () => {
    const wav = riff(chunk('fmt ', fmtBody()), chunk('data', PCM));
    const audio = extractPcm(wav);
    expect(audio.pcm.buffer).toBe(wav.buffer);
  });

  describe('rejects', () => {
    it.each([
      ['an empty buffer', Buffer.alloc(0)],
      ['a too-short buffer', Buffer.from('RIFF')],
      ['a non-RIFF file', Buffer.from('OggS\x00\x00\x00\x00WAVEfmt ')],
      ['RIFF that is not WAVE', Buffer.from('RIFF\x00\x00\x00\x00AVI LIST')],
    ])('%s', (_label, input) => {
      expect(() => extractPcm(input)).toThrow(InvalidWavError);
      expect(() => extractPcm(input)).toThrow(
        'Invalid WAV data: missing RIFF/WAVE header'
      );
    });

    it('a non-PCM format', () => {
      const wav = riff(
        chunk('fmt ', fmtBody({ format: 3 })),
        chunk('data', PCM)
      );
      expect(() => extractPcm(wav)).toThrow('unsupported format 3');
    });

    it('a truncated fmt chunk', () => {
      const wav = riff(chunk('fmt ', Buffer.alloc(8)));
      expect(() => extractPcm(wav)).toThrow('truncated fmt chunk');
    });

    it('a fmt chunk whose body runs past the end', () => {
      const wav = riff(chunk('fmt ', fmtBody())).subarray(0, 12 + 8 + 10);
      expect(() => extractPcm(wav)).toThrow('truncated fmt chunk');
    });

    it('a file with no data chunk', () => {
      expect(() => extractPcm(riff(chunk('fmt ', fmtBody())))).toThrow(
        'no data chunk'
      );
    });

    it('a data chunk before the fmt chunk', () => {
      const wav = riff(chunk('data', PCM), chunk('fmt ', fmtBody()));
      expect(() => extractPcm(wav)).toThrow('data chunk before fmt chunk');
    });

    it('names the error', () => {
      try {
        extractPcm(Buffer.alloc(0));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('InvalidWavError');
      }
    });
  });
});

describe('playbackDurationMs', () => {
  it('is 1000 ms for one second of 48 kHz stereo s16le', () => {
    expect(PLAYBACK_BYTES_PER_SECOND).toBe(192_000);
    expect(playbackDurationMs(Buffer.alloc(PLAYBACK_BYTES_PER_SECOND))).toBe(
      1000
    );
  });

  it('rounds partial milliseconds up', () => {
    expect(playbackDurationMs(Buffer.alloc(1))).toBe(1);
    expect(playbackDurationMs(Buffer.alloc(192 + 1))).toBe(2);
  });

  it('is 0 for an empty buffer', () => {
    expect(playbackDurationMs(Buffer.alloc(0))).toBe(0);
  });
});
