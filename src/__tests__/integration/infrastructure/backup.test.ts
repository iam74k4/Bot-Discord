import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every path lives under a throwaway directory in the OS temp dir, so the
 * suite never creates or deletes anything inside the repository.
 */
const paths = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'bot-backup-service-'));
  return {
    root,
    backupDir: join(root, 'backups'),
    dataDir: join(root, 'data'),
    databasePath: join(root, 'data', 'bot.db'),
  };
});

// The bot's own connection is a stand-in: the worker copies the real file at
// databaseFilePath() with a connection of its own, and the stand-in shows
// whether anything fell back to the main thread.
vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: {
    pragma: vi.fn(),
    backup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  },
  databaseFilePath: () => paths.databasePath,
}));

// Mock env
vi.mock('../../../config/index.js', () => ({
  env: {
    BACKUP_DIR: paths.backupDir,
    BACKUP_RETENTION_DAYS: 7,
    BACKUP_CRON: '0 4 * * *',
    DATABASE_PATH: paths.databasePath,
    TZ: 'UTC',
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// Import after mocks
import {
  BackupService,
  backupService,
} from '../../../infrastructure/backup/index.js';
import type {
  SnapshotWorker,
  SpawnSnapshotWorker,
} from '../../../infrastructure/backup/snapshot.js';
import type { IBackupStorage } from '../../../infrastructure/backup/storage/index.js';
import { database } from '../../../infrastructure/database/connection.js';
import { logger } from '../../../shared/utils/logger.js';

const BACKUP_NAME =
  /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\.db$/;

/** A live database at the configured path, as the running bot would have. */
function createLiveDatabase(rows: string[]): void {
  const live = new Database(paths.databasePath);
  live.pragma('journal_mode = WAL');
  live.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert = live.prepare('INSERT INTO notes (body) VALUES (?)');
  for (const row of rows) insert.run(row);
  live.close();
}

/** A backup worker double whose events the test fires by hand. */
class FakeWorker extends EventEmitter implements SnapshotWorker {
  terminate = vi.fn(async () => {
    this.emit('exit', 1);
    return 1;
  });
}

/** A worker that copies only when the test calls `finish()`. */
class HeldWorker extends FakeWorker {
  constructor(readonly destination: string) {
    super();
  }

  finish(): void {
    fs.writeFileSync(this.destination, 'copy');
    this.emit('message', { type: 'started' });
    this.emit('message', { type: 'done' });
    this.emit('exit', 0);
  }
}

/**
 * Spawns held workers and lets the test await each spawn, so a test waits
 * for the event itself rather than polling for it.
 */
function holdingSpawner() {
  const workers: HeldWorker[] = [];
  const waiting = new Map<number, (worker: HeldWorker) => void>();
  const spawnWorker: SpawnSnapshotWorker = (job) => {
    const worker = new HeldWorker(job.destination);
    waiting.get(workers.length)?.(worker);
    workers.push(worker);
    return worker;
  };
  return {
    workers,
    spawnWorker,
    /** The `index`th worker (from 0), once it has been spawned. */
    spawned(index: number): Promise<HeldWorker> {
      const existing = workers[index];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiting.set(index, resolve));
    },
  };
}

/**
 * Let every pending promise callback and immediate run. Only meaningful where
 * the step being waited for involves no file I/O.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Backups held in memory, so restoring one involves no file I/O. */
function memoryStorage(initial: Record<string, string> = {}) {
  const files = new Map(
    Object.entries(initial).map(([name, body]) => [name, Buffer.from(body)])
  );
  return {
    put: vi.fn(async (filename: string, localPath: string) => {
      files.set(filename, fs.readFileSync(localPath));
    }),
    get: vi.fn(async (filename: string) => {
      const data = files.get(filename);
      if (!data) throw new Error(`No backup named ${filename}`);
      return data;
    }),
    list: vi.fn(async () =>
      [...files].map(([filename, data]) => ({
        filename,
        size: data.length,
        createdAt: new Date(),
      }))
    ),
    delete: vi.fn(async (filename: string) => {
      files.delete(filename);
    }),
  } satisfies IBackupStorage;
}

/** Write a backup file whose modification time is `at`. */
function writeBackup(filename: string, at: Date, content = 'test'): string {
  const file = path.join(paths.backupDir, filename);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, at, at);
  return file;
}

describe('BackupService', () => {
  const testBackupDir = paths.backupDir;
  const testDataDir = paths.dataDir;

  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true });
    }
    fs.mkdirSync(testBackupDir, { recursive: true });
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
  });

  afterEach(() => {
    backupService.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true });
    }
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  describe('runBackup', () => {
    it('copies the live database in a worker, leaving the main connection alone', async () => {
      createLiveDatabase(['first', 'second']);

      const result = await backupService.runBackup();

      expect(result.success).toBe(true);
      expect(result.filename).toMatch(BACKUP_NAME);
      const file = path.join(testBackupDir, result.filename);
      expect(result.size).toBe(fs.statSync(file).size);
      expect(fs.readdirSync(testBackupDir)).toEqual([result.filename]);

      const copy = new Database(file, { fileMustExist: true });
      expect(copy.prepare('SELECT body FROM notes ORDER BY id').all()).toEqual([
        { body: 'first' },
        { body: 'second' },
      ]);
      copy.close();

      // Nothing ran on the bot's connection: no main-thread copy, and no
      // checkpoint that would take the write lock.
      expect(database.backup).not.toHaveBeenCalled();
      expect(database.pragma).not.toHaveBeenCalled();
    });

    it('reports a failed copy without retrying it on the main thread or leaving a file', async () => {
      // No database at the configured path: the worker cannot open it.
      const result = await backupService.runBackup();

      expect(result.success).toBe(false);
      expect(result.error).toEqual(expect.any(String));
      expect(result.size).toBe(0);
      expect(database.backup).not.toHaveBeenCalled();
      expect(fs.readdirSync(testBackupDir)).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Backup failed:', result.error);
    });

    it('removes what a failing worker had already written', async () => {
      const worker = new FakeWorker();
      const service = new BackupService({
        spawnWorker: (job) => {
          setImmediate(() => {
            fs.writeFileSync(job.destination, 'half a database');
            fs.writeFileSync(`${job.destination}-journal`, 'rollback journal');
            worker.emit('message', { type: 'started' });
            worker.emit('message', {
              type: 'done',
              error: 'database or disk is full',
            });
            worker.emit('exit', 0);
          });
          return worker;
        },
      });

      const result = await service.runBackup();

      expect(result).toMatchObject({
        success: false,
        error: 'database or disk is full',
      });
      expect(fs.readdirSync(testBackupDir)).toEqual([]);
    });

    it('copies on the main thread when no worker can run', async () => {
      vi.mocked(database.backup).mockImplementation(
        async (filePath: string) => {
          fs.writeFileSync(filePath, 'main-thread copy');
          return { totalPages: 1, remainingPages: 0 };
        }
      );
      const service = new BackupService({
        spawnWorker: () => {
          throw new Error('worker threads are disabled');
        },
      });

      const result = await service.runBackup();

      expect(result.success).toBe(true);
      expect(result.size).toBe('main-thread copy'.length);
      expect(database.backup).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(testBackupDir)).toEqual([result.filename]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Backup worker unavailable (worker threads are disabled); copying on the main thread instead'
      );
    });

    it('reports a main-thread fallback that fails as well', async () => {
      vi.mocked(database.backup).mockRejectedValueOnce(
        new Error('Backup failed')
      );
      const service = new BackupService({
        spawnWorker: () => {
          throw new Error('worker threads are disabled');
        },
      });

      const result = await service.runBackup();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Backup failed');
      expect(fs.readdirSync(testBackupDir)).toEqual([]);
    });

    it('runs one backup at a time', async () => {
      const spawner = holdingSpawner();
      const service = new BackupService({ spawnWorker: spawner.spawnWorker });

      const first = service.runBackup();
      const second = service.runBackup();
      const firstWorker = await spawner.spawned(0);
      // Had the second backup not waited, it would have spawned its worker
      // in the same tick as the first: nothing in between touches the disk.
      await flush();
      expect(spawner.workers).toHaveLength(1);

      firstWorker.finish();
      await expect(first).resolves.toMatchObject({ success: true });
      (await spawner.spawned(1)).finish();
      await expect(second).resolves.toMatchObject({ success: true });

      const [a, b] = await Promise.all([first, second]);
      expect(fs.readdirSync(testBackupDir).sort()).toEqual(
        [a.filename, b.filename].sort()
      );
    });

    it('clears out copies an earlier run never finished', async () => {
      createLiveDatabase(['row']);
      // What a run killed mid-copy leaves behind: the partial copy and
      // SQLite's rollback journal for it, each as large as the database.
      const orphan = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00-abcdef.db.partial'
      );
      fs.writeFileSync(orphan, 'half a database');
      fs.writeFileSync(`${orphan}-journal`, 'rollback journal');
      fs.writeFileSync(path.join(testBackupDir, 'notes.txt'), 'kept');
      const service = new BackupService();

      const result = await service.runBackup();

      expect(result.success).toBe(true);
      expect(fs.readdirSync(testBackupDir).sort()).toEqual(
        [result.filename, 'notes.txt'].sort()
      );
    });

    it('leaves a copy in progress alone when the backups are listed meanwhile', async () => {
      const spawner = holdingSpawner();
      const service = new BackupService({ spawnWorker: spawner.spawnWorker });

      const backup = service.runBackup();
      const worker = await spawner.spawned(0);
      fs.writeFileSync(worker.destination, 'half a database');
      // The admin panel lists backups whenever it is opened.
      await service.listBackups();

      expect(fs.existsSync(worker.destination)).toBe(true);
      worker.finish();
      await expect(backup).resolves.toMatchObject({ success: true });
    });
  });

  describe('listBackups', () => {
    it('should return empty array when no backups exist', async () => {
      const backups = await backupService.listBackups();
      expect(backups).toEqual([]);
    });

    it('should list existing backup files', async () => {
      const backupFile = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00.db'
      );
      fs.writeFileSync(backupFile, 'test content');

      const backups = await backupService.listBackups();

      expect(backups.length).toBe(1);
      expect(backups[0].filename).toBe('backup-2024-01-01T00-00-00.db');
      expect(backups[0].size).toBe('test content'.length);
    });

    it('should sort backups by date (newest first)', async () => {
      writeBackup(
        'backup-2024-01-01T00-00-00.db',
        new Date('2024-01-01T00:00:00Z')
      );
      writeBackup(
        'backup-2024-01-03T00-00-00.db',
        new Date('2024-01-03T00:00:00Z')
      );
      writeBackup(
        'backup-2024-01-02T00-00-00.db',
        new Date('2024-01-02T00:00:00Z')
      );

      const backups = await backupService.listBackups();

      expect(backups.map((backup) => backup.filename)).toEqual([
        'backup-2024-01-03T00-00-00.db',
        'backup-2024-01-02T00-00-00.db',
        'backup-2024-01-01T00-00-00.db',
      ]);
    });

    it('should ignore files that are not backups', async () => {
      fs.writeFileSync(path.join(testBackupDir, 'notes.txt'), 'x');
      fs.writeFileSync(path.join(testBackupDir, 'backup-latest.db'), 'x');
      writeBackup(
        'backup-2024-01-01T00-00-00.db',
        new Date('2024-01-01T00:00:00Z')
      );

      const backups = await backupService.listBackups();

      expect(backups.map((backup) => backup.filename)).toEqual([
        'backup-2024-01-01T00-00-00.db',
      ]);
    });
  });

  describe('deleteOldBackups', () => {
    it('should delete backups older than retention period', async () => {
      const oldFile = path.join(testBackupDir, 'backup-2020-01-01T00-00-00.db');
      const recentFile = path.join(
        testBackupDir,
        'backup-2099-01-01T00-00-00.db'
      );
      fs.writeFileSync(oldFile, 'old content');
      fs.writeFileSync(recentFile, 'recent content');

      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, oldTime, oldTime);

      const deleted = await backupService.deleteOldBackups();

      expect(deleted).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('should return 0 when no old backups exist', async () => {
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-2099-01-01T00-00-00.db'),
        'recent'
      );

      const deleted = await backupService.deleteOldBackups();

      expect(deleted).toBe(0);
    });
  });

  describe('restore', () => {
    it('should reject invalid filename', async () => {
      const result = await backupService.restore('../etc/passwd');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid backup filename format');
      expect(database.close).not.toHaveBeenCalled();
    });

    it('should restore from existing backup', async () => {
      // restore() schedules process.exit(0) a second later; keep it fake.
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const backupFile = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00.db'
      );
      fs.writeFileSync(backupFile, 'backup data');
      fs.writeFileSync(paths.databasePath, 'current data');
      // Left behind next to the live file: SQLite would replay these frames
      // over the restored database on the next start.
      fs.writeFileSync(`${paths.databasePath}-wal`, 'stale frames');
      fs.writeFileSync(`${paths.databasePath}-shm`, 'stale index');

      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result.success).toBe(true);
      expect(database.close).toHaveBeenCalled();
      expect(fs.readFileSync(paths.databasePath, 'utf-8')).toBe('backup data');
      expect(fs.readdirSync(testDataDir)).toEqual(['bot.db']);

      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('waits for a backup in progress before closing and replacing the database', async () => {
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      const storage = memoryStorage({
        'backup-2024-01-01T00-00-00.db': 'backup data',
      });
      const spawner = holdingSpawner();
      const service = new BackupService({
        createStorage: () => storage,
        spawnWorker: spawner.spawnWorker,
      });

      const backup = service.runBackup();
      const restore = service.restore('backup-2024-01-01T00-00-00.db');
      const worker = await spawner.spawned(0);
      // A restore that did not wait would already have read the backup:
      // with storage in memory, nothing before that touches the disk.
      await flush();

      // The worker still has the file open.
      expect(storage.get).not.toHaveBeenCalled();
      expect(database.close).not.toHaveBeenCalled();
      expect(fs.existsSync(paths.databasePath)).toBe(false);

      // restore() schedules process.exit(0) a second later; keep it fake.
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      worker.finish();

      await expect(backup).resolves.toMatchObject({ success: true });
      await expect(restore).resolves.toEqual({ success: true });
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(paths.databasePath, 'utf-8')).toBe('backup data');
      vi.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('leaves the running database alone when the restored copy cannot be written', async () => {
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      writeBackup('backup-2024-01-01T00-00-00.db', new Date(), 'backup data');
      fs.writeFileSync(paths.databasePath, 'current data');
      fs.writeFileSync(`${paths.databasePath}-wal`, 'recent commits');
      // Stands in for a full disk: the staging file cannot be written.
      fs.mkdirSync(`${paths.databasePath}.restore`);

      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('EISDIR'),
      });
      // The bot keeps running on its own database, WAL included.
      expect(database.close).not.toHaveBeenCalled();
      expect(fs.readFileSync(paths.databasePath, 'utf-8')).toBe('current data');
      expect(fs.readFileSync(`${paths.databasePath}-wal`, 'utf-8')).toBe(
        'recent commits'
      );
      vi.advanceTimersByTime(1000);
      expect(exit).not.toHaveBeenCalled();
    });

    it('exits so the bot restarts when the restored copy cannot be moved into place', async () => {
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      writeBackup('backup-2024-01-01T00-00-00.db', new Date(), 'backup data');
      // A non-empty directory where the database file goes: the copy is
      // written, the connection closed, and then the rename fails.
      fs.mkdirSync(path.join(paths.databasePath, 'in-the-way'), {
        recursive: true,
      });

      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result).toEqual({ success: false, error: expect.any(String) });
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(`${paths.databasePath}.restore`)).toBe(false);
      // Running on with a closed connection would fail every command.
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('should return error when backup file not found', async () => {
      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(database.close).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('should start and stop the backup service', () => {
      expect(backupService.isRunning()).toBe(false);

      backupService.start();
      expect(backupService.isRunning()).toBe(true);

      backupService.stop();
      expect(backupService.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      backupService.start();
      backupService.start();

      expect(backupService.isRunning()).toBe(true);
    });
  });
});
