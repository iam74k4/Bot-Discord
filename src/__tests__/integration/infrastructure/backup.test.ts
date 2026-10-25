import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from 'vitest';
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

// Mock the database before importing backup service
vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: {
    pragma: vi.fn(),
    backup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  },
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
import { backupService } from '../../../infrastructure/backup/index.js';
import { database } from '../../../infrastructure/database/connection.js';

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
    it('should create a backup file', async () => {
      vi.mocked(database.backup).mockImplementation(
        async (filePath: string) => {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, 'mock backup content');
          return { totalPages: 1, remainingPages: 0 };
        }
      );

      const result = await backupService.runBackup();

      expect(result.success).toBe(true);
      expect(result.filename).toMatch(
        /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{6}\.db$/
      );
      expect(result.size).toBe('mock backup content'.length);
      expect(database.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
      expect(database.backup).toHaveBeenCalledWith(
        path.join(testBackupDir, result.filename)
      );
      expect(fs.readdirSync(testBackupDir)).toEqual([result.filename]);
    });

    it('should return error on failure', async () => {
      vi.mocked(database.backup).mockRejectedValueOnce(
        new Error('Backup failed')
      );

      const result = await backupService.runBackup();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Backup failed');
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

      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result.success).toBe(true);
      expect(database.close).toHaveBeenCalled();
      expect(fs.readFileSync(paths.databasePath, 'utf-8')).toBe('backup data');

      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(0);
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

  describe('formatBackupList', () => {
    it('should return "No backups found" when empty', async () => {
      const formatted = await backupService.formatBackupList();
      expect(formatted).toBe('No backups found.');
    });

    it('should format backup list correctly', async () => {
      writeBackup(
        'backup-2024-01-01T00-00-00.db',
        new Date('2024-01-01T08:30:00Z'),
        'x'.repeat(2048)
      );

      const formatted = await backupService.formatBackupList();

      expect(formatted).toBe(
        '1. `backup-2024-01-01T00-00-00.db` (2 KB) - 2024-01-01 08:30:00'
      );
    });

    it('should show "... and N more" for more than 10 backups', async () => {
      fs.mkdirSync(testBackupDir, { recursive: true });

      for (let i = 0; i < 12; i++) {
        const day = String(i + 1).padStart(2, '0');
        fs.writeFileSync(
          path.join(testBackupDir, `backup-2024-01-${day}T00-00-00.db`),
          'x'
        );
      }

      const formatted = await backupService.formatBackupList();

      expect(formatted).toContain('... and 2 more');
      expect(formatted.split('\n')).toHaveLength(11);
    });
  });
});
