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
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { logger } from '../../../shared/utils/logger.js';
import { FileCleanupService } from '../jobs/fileCleanup.js';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_HOURS = 24;
/** Whole second, so file mtimes set from it round-trip exactly. */
const NOW = new Date('2026-10-24T12:00:00.000Z').getTime();

let tempRoot: string;
let recordingsDir: string;

/** FileCleanupService joins RECORDINGS_DIR onto process.cwd(). */
function serviceFor(dir: string, retentionHours = RETENTION_HOURS) {
  return new FileCleanupService({
    RECORDING_RETENTION_HOURS: retentionHours,
    RECORDINGS_DIR: relative(process.cwd(), dir),
  });
}

async function createFile(
  name: string,
  ageMs: number,
  content: string | Buffer = 'x'
): Promise<string> {
  const filePath = join(recordingsDir, name);
  await writeFile(filePath, content);
  const mtimeSeconds = (NOW - ageMs) / 1000;
  await utimes(filePath, mtimeSeconds, mtimeSeconds);
  return filePath;
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false
  );
}

describe('FileCleanupService', () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'voice-cleanup-test-'));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Only Date is faked: fs callbacks still need the real event loop.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    recordingsDir = await mkdtemp(join(tempRoot, 'rec-'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cleanup', () => {
    it('deletes recordings older than the retention window and keeps fresh ones', async () => {
      const old = await createFile('old.wav', (RETENTION_HOURS + 1) * HOUR_MS);
      const fresh = await createFile('fresh.wav', HOUR_MS);

      await serviceFor(recordingsDir).cleanup();

      expect(await exists(old)).toBe(false);
      expect(await exists(fresh)).toBe(true);
    });

    it('keeps a file exactly at the cutoff and deletes one a second older', async () => {
      const retentionMs = RETENTION_HOURS * HOUR_MS;
      const atCutoff = await createFile('at-cutoff.wav', retentionMs);
      const pastCutoff = await createFile('past.wav', retentionMs + 1000);

      await serviceFor(recordingsDir).cleanup();

      expect(await exists(atCutoff)).toBe(true);
      expect(await exists(pastCutoff)).toBe(false);
    });

    it('uses the configured retention hours', async () => {
      const twoHoursOld = await createFile('two-hours.wav', 2 * HOUR_MS);

      await serviceFor(recordingsDir, 3).cleanup();
      expect(await exists(twoHoursOld)).toBe(true);

      await serviceFor(recordingsDir, 1).cleanup();
      expect(await exists(twoHoursOld)).toBe(false);
    });

    it('never touches non-wav files, however old', async () => {
      const ancientAge = 365 * 24 * HOUR_MS;
      const notes = await createFile('notes.txt', ancientAge);
      const partial = await createFile('recording.wav.tmp', ancientAge);

      await serviceFor(recordingsDir).cleanup();

      expect(await exists(notes)).toBe(true);
      expect(await exists(partial)).toBe(true);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs how many files and megabytes were freed', async () => {
      const mb = 1024 * 1024;
      await createFile('a.wav', 48 * HOUR_MS, Buffer.alloc(mb));
      await createFile('b.wav', 48 * HOUR_MS, Buffer.alloc(mb / 2));

      await serviceFor(recordingsDir).cleanup();

      expect(logger.info).toHaveBeenCalledWith(
        'Cleaned up 2 old recording files (1.50MB)'
      );
    });

    it('stays quiet when nothing is old enough to delete', async () => {
      await createFile('fresh.wav', HOUR_MS);

      await serviceFor(recordingsDir).cleanup();

      expect(logger.info).not.toHaveBeenCalled();
    });

    it('tolerates a recordings directory that does not exist yet', async () => {
      const missing = join(recordingsDir, 'missing');

      await expect(serviceFor(missing).cleanup()).resolves.toBeUndefined();
      expect(await exists(missing)).toBe(false);
    });

    it('rethrows directory errors other than ENOENT', async () => {
      const notADir = await createFile('plain-file', 0);

      await expect(serviceFor(notADir).cleanup()).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });

    it('skips an entry it cannot stat and still cleans the rest', async () => {
      await symlink(
        join(recordingsDir, 'gone'),
        join(recordingsDir, 'dangling.wav')
      );
      const old = await createFile('old.wav', 48 * HOUR_MS);

      await serviceFor(recordingsDir).cleanup();

      expect(await exists(old)).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to process file dangling.wav:',
        expect.stringContaining('ENOENT')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cleaned up 1 old recording files')
      );
    });

    it('skips an entry it cannot delete and still cleans the rest', async () => {
      // unlink() refuses directories, even for root.
      const undeletable = join(recordingsDir, 'folder.wav');
      await mkdir(undeletable);
      const oldSeconds = (NOW - 48 * HOUR_MS) / 1000;
      await utimes(undeletable, oldSeconds, oldSeconds);
      const old = await createFile('old.wav', 48 * HOUR_MS);

      await serviceFor(recordingsDir).cleanup();

      expect(await exists(old)).toBe(false);
      expect(await exists(undeletable)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to process file folder.wav:',
        expect.any(String)
      );
    });
  });

  describe('getDiskUsage', () => {
    it('counts only wav files and reports their total size in MB', async () => {
      const mb = 1024 * 1024;
      await createFile('a.wav', 0, Buffer.alloc(mb));
      await createFile('b.wav', 0, Buffer.alloc(mb / 4));
      await createFile('ignored.txt', 0, Buffer.alloc(mb));

      await expect(serviceFor(recordingsDir).getDiskUsage()).resolves.toEqual({
        fileCount: 2,
        totalSizeMB: 1.25,
      });
    });

    it('reports zero for an empty directory', async () => {
      await expect(serviceFor(recordingsDir).getDiskUsage()).resolves.toEqual({
        fileCount: 0,
        totalSizeMB: 0,
      });
    });

    it('reports zero when the directory does not exist', async () => {
      await expect(
        serviceFor(join(recordingsDir, 'missing')).getDiskUsage()
      ).resolves.toEqual({ fileCount: 0, totalSizeMB: 0 });
    });

    it('skips entries it cannot stat', async () => {
      await symlink(
        join(recordingsDir, 'gone'),
        join(recordingsDir, 'dangling.wav')
      );
      await createFile('real.wav', 0, Buffer.alloc(1024 * 1024));

      await expect(serviceFor(recordingsDir).getDiskUsage()).resolves.toEqual({
        fileCount: 1,
        totalSizeMB: 1,
      });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipped file dangling.wav')
      );
    });

    it('rethrows directory errors other than ENOENT', async () => {
      const notADir = await createFile('plain-file', 0);

      await expect(serviceFor(notADir).getDiskUsage()).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });
  });

  describe('start / stop scheduling', () => {
    let service: FileCleanupService;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(NOW);
      service = serviceFor(recordingsDir);
    });

    afterEach(() => {
      service.stop();
    });

    it('cleans up immediately on start', async () => {
      const old = await createFile('old.wav', 48 * HOUR_MS);

      service.start();

      await vi.waitFor(async () => {
        expect(await exists(old)).toBe(false);
      });
      expect(logger.info).toHaveBeenCalledWith('File cleanup service started');
    });

    it('cleans up again every hour', async () => {
      const cleanup = vi.spyOn(service, 'cleanup').mockResolvedValue();

      service.start();
      expect(cleanup).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(HOUR_MS - 1);
      expect(cleanup).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(cleanup).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(HOUR_MS);
      expect(cleanup).toHaveBeenCalledTimes(3);
    });

    it('warns and does not schedule twice when started again', () => {
      const cleanup = vi.spyOn(service, 'cleanup').mockResolvedValue();

      service.start();
      service.start();

      expect(logger.warn).toHaveBeenCalledWith(
        'File cleanup service is already running'
      );
      vi.advanceTimersByTime(HOUR_MS);
      expect(cleanup).toHaveBeenCalledTimes(2);
    });

    it('stops the hourly cleanup and can be started again', () => {
      const cleanup = vi.spyOn(service, 'cleanup').mockResolvedValue();

      service.start();
      service.stop();
      expect(logger.info).toHaveBeenCalledWith('File cleanup service stopped');

      vi.advanceTimersByTime(3 * HOUR_MS);
      expect(cleanup).toHaveBeenCalledTimes(1);

      service.start();
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('ignores stop when it was never started', () => {
      service.stop();

      expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs a failed initial cleanup instead of throwing', async () => {
      const failure = new Error('disk unavailable');
      vi.spyOn(service, 'cleanup').mockRejectedValueOnce(failure);

      expect(() => service.start()).not.toThrow();

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Initial cleanup failed:',
          failure
        );
      });
    });

    it('logs a failed periodic cleanup and keeps the schedule running', async () => {
      const failure = new Error('disk unavailable');
      const cleanup = vi
        .spyOn(service, 'cleanup')
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue();

      service.start();
      vi.advanceTimersByTime(HOUR_MS);

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Periodic cleanup failed:',
          failure
        );
      });

      vi.advanceTimersByTime(HOUR_MS);
      expect(cleanup).toHaveBeenCalledTimes(3);
    });
  });

  it('only removes files inside its own directory', async () => {
    const sibling = await mkdtemp(join(tempRoot, 'sibling-'));
    const outside = join(sibling, 'other.wav');
    await writeFile(outside, 'x');
    const oldSeconds = (NOW - 48 * HOUR_MS) / 1000;
    await utimes(outside, oldSeconds, oldSeconds);
    await createFile('mine.wav', 48 * HOUR_MS);

    await serviceFor(recordingsDir).cleanup();

    expect(await readdir(recordingsDir)).toEqual([]);
    expect(await exists(outside)).toBe(true);
  });
});
