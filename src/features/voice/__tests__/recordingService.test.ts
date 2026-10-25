import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createWriteStream, type WriteStream } from 'fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, relative } from 'path';
import { Writable } from 'stream';
import { DISCORD_LIMITS } from '../../../config/index.js';
import { parseConfig } from '../../../config/schema.js';
import {
  generateFileName,
  parseDurationString,
  pcmBufferHasAudibleSignal,
  recordAudio,
  RecordingNoAudibleAudioError,
} from '../recording/recordingService.js';

const mockExtractLastSeconds = vi.hoisted(() =>
  vi.fn<(channelId: string, seconds: number) => Buffer>()
);
const mockEnv = vi.hoisted(() => ({
  RECORDINGS_DIR: '',
  MAX_RECORDING_DURATION: 300,
  AUDIO_BUFFER_DURATION: 300,
}));
/**
 * Lets a single test shrink the upload limit so a many-part split stays
 * small on disk. null keeps the real DISCORD_LIMITS value.
 */
const limitOverride = vi.hoisted(() => ({
  maxFileSizeMb: null as number | null,
}));

vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: {
    extractLastSeconds: mockExtractLastSeconds,
  },
}));

// Keep the real AUDIO / DISCORD_LIMITS constants so the WAV and split
// assertions follow whatever the production values are. MAX_FILE_SIZE_MB is
// read through a getter so one test can lower it; every split assertion reads
// DISCORD_LIMITS back instead of hard-coding a size.
vi.mock('../../../config/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/index.js')>();
  return {
    ...actual,
    env: mockEnv,
    DISCORD_LIMITS: {
      ...actual.DISCORD_LIMITS,
      get MAX_FILE_SIZE_MB() {
        return (
          limitOverride.maxFileSizeMb ?? actual.DISCORD_LIMITS.MAX_FILE_SIZE_MB
        );
      },
    },
  };
});

// Real fs, with createWriteStream wrapped so single tests can inject a
// failing stream.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

const WAV_HEADER_BYTES = 44;
/** Upload limit the service splits against, in bytes (real config value). */
const MAX_UPLOAD_BYTES = DISCORD_LIMITS.MAX_FILE_SIZE_MB * 1024 * 1024;

let tempRoot: string;
let recordingsDir: string;

/** recordingService joins env.RECORDINGS_DIR onto process.cwd(). */
function pointRecordingsDirAt(dir: string): void {
  mockEnv.RECORDINGS_DIR = relative(process.cwd(), dir);
}

function pcmFromSamples(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

/**
 * Audible PCM of an exact byte length. The ramp period (997 samples) does not
 * divide any split size, so reordered or dropped parts change the bytes.
 */
function audiblePcm(byteLength: number): Buffer {
  const ramp = pcmFromSamples(
    Array.from({ length: 997 }, (_, i) => (i % 2 === 0 ? 1 : -1) * (200 + i))
  );
  return Buffer.alloc(byteLength, ramp);
}

function parseWav(buf: Buffer) {
  return {
    riff: buf.toString('ascii', 0, 4),
    riffSize: buf.readUInt32LE(4),
    wave: buf.toString('ascii', 8, 12),
    fmt: buf.toString('ascii', 12, 16),
    fmtSize: buf.readUInt32LE(16),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataTag: buf.toString('ascii', 36, 40),
    dataSize: buf.readUInt32LE(40),
    data: buf.subarray(WAV_HEADER_BYTES),
  };
}

/** Header fields every file written by the service must carry. */
function expectMono16Bit48kHeader(wav: ReturnType<typeof parseWav>): void {
  expect(wav.riff).toBe('RIFF');
  expect(wav.wave).toBe('WAVE');
  expect(wav.fmt).toBe('fmt ');
  expect(wav.fmtSize).toBe(16);
  expect(wav.audioFormat).toBe(1); // PCM
  expect(wav.channels).toBe(1);
  expect(wav.sampleRate).toBe(48000);
  expect(wav.bitsPerSample).toBe(16);
  expect(wav.blockAlign).toBe(2);
  expect(wav.byteRate).toBe(48000 * 2);
  expect(wav.dataTag).toBe('data');
  expect(wav.riffSize).toBe(36 + wav.dataSize);
  expect(wav.data.length).toBe(wav.dataSize);
}

function options(channelId: string, duration = 5) {
  return { channelId, duration, userId: 'user-1', guildId: 'guild-1' };
}

/**
 * Name of part `part` of a split recording: the usual recording name with a
 * 1-based `_partN` suffix before the extension.
 */
function expectPartName(
  filePath: string,
  duration: number,
  channelId: string,
  part: number
): void {
  expect(basename(filePath)).toMatch(
    new RegExp(
      `^recording_\\d{8}T\\d{6}-\\d{3}Z_${duration}s_${channelId}_[0-9a-f]{8}_part${part}\\.wav$`
    )
  );
}

/** Writable whose Nth write fails, to simulate a disk error mid-file. */
function streamFailingOnWrite(failOn: number): WriteStream {
  let writes = 0;
  return new Writable({
    write(_chunk, _encoding, callback) {
      writes++;
      callback(writes === failOn ? new Error('disk full') : null);
    },
  }) as unknown as WriteStream;
}

describe('recordingService', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'voice-recording-test-'));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv.MAX_RECORDING_DURATION = 300;
    mockEnv.AUDIO_BUFFER_DURATION = 300;
    recordingsDir = await mkdtemp(join(tempRoot, 'rec-'));
    pointRecordingsDirAt(recordingsDir);
    mockExtractLastSeconds.mockReturnValue(pcmFromSamples([0, 1000, -1000]));
  });

  afterEach(async () => {
    vi.useRealTimers();
    limitOverride.maxFileSizeMb = null;
    // Split tests write tens of MB; free them per test.
    await rm(recordingsDir, { recursive: true, force: true });
  });

  describe('recordAudio validation', () => {
    it.each([0, -5])(
      'rejects a duration of %i without reading the ring',
      async (duration) => {
        await expect(recordAudio(options('ch-zero', duration))).rejects.toThrow(
          'Duration must be greater than 0'
        );
        expect(mockExtractLastSeconds).not.toHaveBeenCalled();
      }
    );

    it('rejects a duration above MAX_RECORDING_DURATION', async () => {
      mockEnv.MAX_RECORDING_DURATION = 60;

      await expect(recordAudio(options('ch-max', 61))).rejects.toThrow(
        'Duration exceeds maximum (60s)'
      );
      expect(mockExtractLastSeconds).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly at MAX_RECORDING_DURATION', async () => {
      mockEnv.MAX_RECORDING_DURATION = 60;

      const result = await recordAudio(options('ch-max-edge', 60));

      expect(result.duration).toBe(60);
      expect(mockExtractLastSeconds).toHaveBeenCalledWith('ch-max-edge', 60);
    });

    it('rejects a duration longer than the audio buffer holds', async () => {
      mockEnv.AUDIO_BUFFER_DURATION = 120;

      await expect(recordAudio(options('ch-buffer', 121))).rejects.toThrow(
        'Duration exceeds buffer duration (120s)'
      );
      expect(mockExtractLastSeconds).not.toHaveBeenCalled();
    });

    it('accepts a duration exactly at AUDIO_BUFFER_DURATION', async () => {
      // The buffer, not the maximum, is the binding limit here.
      mockEnv.MAX_RECORDING_DURATION = 300;
      mockEnv.AUDIO_BUFFER_DURATION = 60;

      const result = await recordAudio(options('ch-buf-edge', 60));

      expect(result.duration).toBe(60);
      expect(mockExtractLastSeconds).toHaveBeenCalledWith('ch-buf-edge', 60);
    });

    it('accepts the longest recording the default config allows', async () => {
      // With the shipped defaults both limits are equal, so the longest
      // `/voice record` sits on both boundaries at once.
      const { config } = parseConfig({
        DISCORD_TOKEN: 'token',
        DISCORD_CLIENT_ID: 'client-id',
      });
      mockEnv.MAX_RECORDING_DURATION = config.MAX_RECORDING_DURATION;
      mockEnv.AUDIO_BUFFER_DURATION = config.AUDIO_BUFFER_DURATION;
      const longest = Math.min(
        config.MAX_RECORDING_DURATION,
        config.AUDIO_BUFFER_DURATION
      );

      const result = await recordAudio(options('ch-default-max', longest));

      expect(result.duration).toBe(longest);
      expect(mockExtractLastSeconds).toHaveBeenCalledWith(
        'ch-default-max',
        longest
      );
    });

    it('does not reserve the channel when validation fails', async () => {
      await expect(recordAudio(options('ch-validate', 0))).rejects.toThrow();

      await expect(
        recordAudio(options('ch-validate', 5))
      ).resolves.toMatchObject({ isSplit: false });
    });
  });

  describe('silence detection', () => {
    it('treats the threshold as exclusive for positive and negative samples', () => {
      expect(pcmBufferHasAudibleSignal(pcmFromSamples([48, -48]))).toBe(false);
      expect(pcmBufferHasAudibleSignal(pcmFromSamples([49]))).toBe(true);
      expect(pcmBufferHasAudibleSignal(pcmFromSamples([-49]))).toBe(true);
      expect(pcmBufferHasAudibleSignal(pcmFromSamples([-32768]))).toBe(true);
    });

    it('honours a custom threshold', () => {
      const buf = pcmFromSamples([500]);
      expect(pcmBufferHasAudibleSignal(buf, 499)).toBe(true);
      expect(pcmBufferHasAudibleSignal(buf, 500)).toBe(false);
    });

    it('finds a single audible sample at the end of a long silent buffer', () => {
      const samples = new Array<number>(48000).fill(0);
      samples[samples.length - 1] = 1000;
      expect(pcmBufferHasAudibleSignal(pcmFromSamples(samples))).toBe(true);
    });

    it('reports an empty buffer as silent', () => {
      expect(pcmBufferHasAudibleSignal(Buffer.alloc(0))).toBe(false);
    });

    it('rejects with RecordingNoAudibleAudioError when the channel has no ring', async () => {
      mockExtractLastSeconds.mockReturnValue(Buffer.alloc(0));

      const error = await recordAudio(options('ch-empty')).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(RecordingNoAudibleAudioError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('RecordingNoAudibleAudioError');
      expect(await readdir(recordingsDir)).toEqual([]);
    });

    it('rejects a window that only contains noise-floor samples and writes nothing', async () => {
      mockExtractLastSeconds.mockReturnValue(
        pcmFromSamples(Array.from({ length: 4800 }, (_, i) => (i % 97) - 48))
      );

      await expect(recordAudio(options('ch-noise'))).rejects.toBeInstanceOf(
        RecordingNoAudibleAudioError
      );
      expect(await readdir(recordingsDir)).toEqual([]);
    });

    it('releases the channel after a silent-window failure so retries can proceed', async () => {
      mockExtractLastSeconds.mockReturnValue(Buffer.alloc(96000));

      await expect(recordAudio(options('ch-retry', 1))).rejects.toBeInstanceOf(
        RecordingNoAudibleAudioError
      );
      // A second call must not report "already in progress" after the throw.
      await expect(recordAudio(options('ch-retry', 1))).rejects.toBeInstanceOf(
        RecordingNoAudibleAudioError
      );
    });
  });

  describe('WAV output', () => {
    it('writes a 48 kHz 16-bit mono header followed by the PCM data', async () => {
      const pcm = pcmFromSamples([0, 1200, -1200, 32767, -32768, 7]);
      mockExtractLastSeconds.mockReturnValue(pcm);

      const result = await recordAudio(options('ch-wav', 3));

      const file = await readFile(result.filePath);
      const wav = parseWav(file);
      expectMono16Bit48kHeader(wav);
      expect(wav.dataSize).toBe(pcm.length);
      expect(wav.data.equals(pcm)).toBe(true);
      expect(file.length).toBe(WAV_HEADER_BYTES + pcm.length);
      expect(mockExtractLastSeconds).toHaveBeenCalledWith('ch-wav', 3);
    });

    it('returns the written file path, its real size and the duration', async () => {
      const pcm = audiblePcm(96000);
      mockExtractLastSeconds.mockReturnValue(pcm);

      const result = await recordAudio(options('ch-result', 1));

      expect(dirname(result.filePath)).toBe(recordingsDir);
      expect(result.fileSize).toBe((await stat(result.filePath)).size);
      expect(result.fileSize).toBe(WAV_HEADER_BYTES + pcm.length);
      expect(result.duration).toBe(1);
      expect(result.isSplit).toBe(false);
      expect(result.additionalFiles).toBeUndefined();
    });

    it('creates the recordings directory when it does not exist yet', async () => {
      const nested = join(recordingsDir, 'not', 'yet', 'created');
      pointRecordingsDirAt(nested);

      const result = await recordAudio(options('ch-mkdir'));

      expect(dirname(result.filePath)).toBe(nested);
      expect(await readdir(nested)).toEqual([basename(result.filePath)]);
    });
  });

  describe('file splitting', () => {
    it('keeps a recording that exactly fills the upload limit in one file', async () => {
      const pcm = audiblePcm(MAX_UPLOAD_BYTES - WAV_HEADER_BYTES);
      mockExtractLastSeconds.mockReturnValue(pcm);

      const result = await recordAudio(options('ch-at-limit'));

      expect(result.isSplit).toBe(false);
      expect(result.fileSize).toBe(MAX_UPLOAD_BYTES);
      expect(await readdir(recordingsDir)).toHaveLength(1);
    });

    it('splits a recording one sample over the limit into valid, upload-sized WAV parts', async () => {
      const pcm = audiblePcm(MAX_UPLOAD_BYTES - WAV_HEADER_BYTES + 2);
      mockExtractLastSeconds.mockReturnValue(pcm);

      const result = await recordAudio(options('ch-split', 60));

      expect(result.isSplit).toBe(true);
      const parts = [result.filePath, ...(result.additionalFiles ?? [])];
      expect(parts).toHaveLength(2);
      expect((await readdir(recordingsDir)).sort()).toEqual(
        parts.map((p) => basename(p)).sort()
      );
      expect(result.fileSize).toBe((await stat(result.filePath)).size);
      expect(result.duration).toBe(60);

      const dataParts: Buffer[] = [];
      for (const [index, part] of parts.entries()) {
        expectPartName(part, 60, 'ch-split', index + 1);
        const file = await readFile(part);
        expect(file.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);

        const wav = parseWav(file);
        expectMono16Bit48kHeader(wav);
        // A part must never cut an int16 sample in half.
        expect(wav.dataSize % wav.blockAlign).toBe(0);
        dataParts.push(Buffer.from(wav.data));
      }

      // Parts are in order and lose no audio.
      expect(Buffer.concat(dataParts).equals(pcm)).toBe(true);
    });

    it('splits a recording several times the limit into three or more ordered parts that each fit', async () => {
      // A small limit keeps this many-part split cheap on disk. Everything
      // below is read back from DISCORD_LIMITS, not from the number set here.
      limitOverride.maxFileSizeMb = 1;
      const limitBytes = DISCORD_LIMITS.MAX_FILE_SIZE_MB * 1024 * 1024;
      // 2.5x the limit, rounded down to whole int16 samples.
      const pcm = audiblePcm(Math.floor(limitBytes * 1.25) * 2);
      mockExtractLastSeconds.mockReturnValue(pcm);

      const result = await recordAudio(options('ch-many', 30));

      expect(result.isSplit).toBe(true);
      const parts = [result.filePath, ...(result.additionalFiles ?? [])];
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(new Set(parts).size).toBe(parts.length);
      expect((await readdir(recordingsDir)).sort()).toEqual(
        parts.map((p) => basename(p)).sort()
      );
      expect(result.fileSize).toBe((await stat(result.filePath)).size);

      const dataParts: Buffer[] = [];
      for (const [index, part] of parts.entries()) {
        expectPartName(part, 30, 'ch-many', index + 1);
        const file = await readFile(part);
        expect(file.length).toBeLessThanOrEqual(limitBytes);

        const wav = parseWav(file);
        expectMono16Bit48kHeader(wav);
        expect(wav.dataSize % wav.blockAlign).toBe(0);
        dataParts.push(Buffer.from(wav.data));
      }

      expect(Buffer.concat(dataParts).equals(pcm)).toBe(true);
    });
  });

  describe('file naming', () => {
    it('encodes the timestamp, duration, channel and a hex nonce', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T12:34:56.789Z'));

      expect(generateFileName(30, 'channel-a')).toMatch(
        /^recording_20261024T123456-789Z_30s_channel-a_[0-9a-f]{8}\.wav$/
      );
    });

    it('is unique for the same channel within the same millisecond', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));

      const names = Array.from({ length: 50 }, () =>
        generateFileName(30, 'channel-a')
      );

      expect(new Set(names).size).toBe(names.length);
    });

    it('is unique across channels in the same second', () => {
      const a = generateFileName(30, 'channel-a');
      const b = generateFileName(30, 'channel-b');
      expect(a).not.toBe(b);
      expect(a).toContain('channel-a');
      expect(b).toContain('channel-b');
    });

    it('strips path characters from the channel id so it cannot escape the directory', () => {
      const name = generateFileName(5, '../../etc/passwd');

      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
      expect(name).toContain('_etcpasswd_');
    });

    it('truncates the channel id part to 32 characters', () => {
      const longId = 'a'.repeat(40);

      const name = generateFileName(5, longId);

      expect(name).toContain(`_${'a'.repeat(32)}_`);
      expect(name).not.toContain('a'.repeat(33));
    });

    it('never overwrites an earlier recording of the same channel in the same instant', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-24T09:00:00.000Z'));

      const first = await recordAudio(options('ch-same'));
      const second = await recordAudio(options('ch-same'));

      expect(first.filePath).not.toBe(second.filePath);
      expect(await readdir(recordingsDir)).toHaveLength(2);
    });
  });

  describe('per-channel queue', () => {
    it('refuses a second recording on a channel while one is in progress', async () => {
      const first = recordAudio(options('ch-busy'));

      await expect(recordAudio(options('ch-busy'))).rejects.toThrow(
        'Recording already in progress for this channel'
      );
      await expect(first).resolves.toMatchObject({ isSplit: false });

      // Released once the first recording finished.
      await expect(recordAudio(options('ch-busy'))).resolves.toMatchObject({
        isSplit: false,
      });
    });

    it('records different channels concurrently into separate files', async () => {
      const [a, b] = await Promise.all([
        recordAudio(options('ch-a')),
        recordAudio(options('ch-b')),
      ]);

      expect(a.filePath).not.toBe(b.filePath);
      expect(basename(a.filePath)).toContain('_ch-a_');
      expect(basename(b.filePath)).toContain('_ch-b_');
      expect(await readdir(recordingsDir)).toHaveLength(2);
    });

    it.each([
      ['header', 1],
      ['PCM data', 2],
    ])(
      'rejects and releases the channel when writing the %s fails',
      async (_label, failOn) => {
        vi.mocked(createWriteStream).mockImplementationOnce(() =>
          streamFailingOnWrite(failOn)
        );

        await expect(recordAudio(options('ch-write-fail'))).rejects.toThrow(
          'disk full'
        );

        await expect(
          recordAudio(options('ch-write-fail'))
        ).resolves.toMatchObject({ isSplit: false });
      }
    );

    it('rejects and releases the channel when the file cannot be opened', async () => {
      // e.g. the directory vanished between mkdir and open.
      const actualFs = await vi.importActual<typeof import('fs')>('fs');
      vi.mocked(createWriteStream).mockImplementationOnce(() =>
        actualFs.createWriteStream(join(recordingsDir, 'vanished', 'x.wav'))
      );

      await expect(recordAudio(options('ch-open-fail'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await expect(recordAudio(options('ch-open-fail'))).resolves.toMatchObject(
        { isSplit: false }
      );
    });

    it('rejects and releases the channel when the recordings directory cannot be created', async () => {
      const blocker = join(recordingsDir, 'blocker');
      await writeFile(blocker, 'not a directory');
      pointRecordingsDirAt(join(blocker, 'recordings'));

      await expect(recordAudio(options('ch-mkdir-fail'))).rejects.toMatchObject(
        { code: 'ENOTDIR' }
      );

      pointRecordingsDirAt(recordingsDir);
      await expect(
        recordAudio(options('ch-mkdir-fail'))
      ).resolves.toMatchObject({ isSplit: false });
    });
  });

  describe('parseDurationString', () => {
    it.each([
      ['30s', 30],
      ['1m', 60],
      ['5m', 300],
      ['2h', 7200],
      ['10S', 10],
      ['3M', 180],
      ['0s', 0],
    ])('parses %s as %i seconds', (input, expected) => {
      expect(parseDurationString(input)).toBe(expected);
    });

    it.each(['', '30', 's', '1.5m', '-1s', '10d', ' 10s', '10s ', '1m30s'])(
      'rejects %j',
      (input) => {
        expect(() => parseDurationString(input)).toThrow(
          'Invalid duration format'
        );
      }
    );
  });
});
