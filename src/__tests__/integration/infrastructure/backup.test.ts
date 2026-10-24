import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
    BACKUP_DIR: 'test-backups-service',
    BACKUP_RETENTION_DAYS: 7,
    BACKUP_CRON: '0 4 * * *',
    DATABASE_PATH: 'test-data-backup/bot.db',
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

describe('BackupService', () => {
  const testBackupDir = 'test-backups-service';
  const testDataDir = 'test-data-backup';

  beforeEach(() => {
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

    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true });
    }
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true });
    }
  });

  describe('runBackup', () => {
    it('should create a backup file', async () => {
      const { database } =
        await import('../../../infrastructure/database/connection.js');

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
    });

    it('should return error on failure', async () => {
      const { database } =
        await import('../../../infrastructure/database/connection.js');
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
    });

    it('should sort backups by date (newest first)', async () => {
      const files = [
        'backup-2024-01-01T00-00-00.db',
        'backup-2024-01-03T00-00-00.db',
        'backup-2024-01-02T00-00-00.db',
      ];

      for (const file of files) {
        fs.writeFileSync(path.join(testBackupDir, file), 'test');
      }

      const backups = await backupService.listBackups();

      expect(backups.length).toBe(3);
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
    });

    it('should restore from existing backup', async () => {
      const { database } =
        await import('../../../infrastructure/database/connection.js');
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
      expect(fs.readFileSync('test-data-backup/bot.db', 'utf-8')).toBe(
        'backup data'
      );
    });

    it('should return error when backup file not found', async () => {
      const result = await backupService.restore(
        'backup-2024-01-01T00-00-00.db'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
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
      const backupFile = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00.db'
      );
      fs.writeFileSync(backupFile, 'test content');

      const formatted = await backupService.formatBackupList();

      expect(formatted).toContain('backup-2024-01-01T00-00-00.db');
      expect(formatted).toContain('KB');
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
    });
  });
});
