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
import { LocalStorage } from '../storage/localStorage.js';
import { validateBackupFilename } from '../storage/types.js';

/**
 * A throwaway directory in the OS temp dir, unique to this run: the suite
 * never writes inside the repository, and two runs at once do not share it.
 */
const dirs = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'bot-local-storage-'));
  return { root, backupDir: join(root, 'backups') };
});

vi.mock('../../../config/index.js', () => ({
  env: {
    BACKUP_DIR: dirs.backupDir,
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('LocalStorage', () => {
  const testBackupDir = dirs.backupDir;

  beforeEach(() => {
    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true });
    }
    fs.mkdirSync(testBackupDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  describe('validateBackupFilename', () => {
    it('should accept valid backup filenames', () => {
      expect(validateBackupFilename('backup-2024-01-01T00-00-00.db')).toBe(
        true
      );
      expect(validateBackupFilename('backup-2030-12-31T23-59-59.db')).toBe(
        true
      );
      expect(
        validateBackupFilename('backup-2024-01-01T00-00-00-a1b2c3.db')
      ).toBe(true);
    });

    it('should reject path traversal attempts', () => {
      expect(validateBackupFilename('../etc/passwd')).toBe(false);
      expect(
        validateBackupFilename('backup-2024-01-01T00-00-00.db/../../../x')
      ).toBe(false);
      expect(validateBackupFilename('..\\..\\etc\\passwd')).toBe(false);
    });

    it('should reject invalid formats', () => {
      expect(validateBackupFilename('backup.db')).toBe(false);
      expect(validateBackupFilename('backup-2024-01-01.db')).toBe(false);
      expect(validateBackupFilename('')).toBe(false);
    });
  });

  describe('put', () => {
    it('should reject invalid filename', async () => {
      const storage = new LocalStorage();
      await expect(
        storage.put('../etc/passwd', '/tmp/test.db')
      ).rejects.toThrow('Invalid backup filename format');
    });

    it('should succeed for valid filename (no-op)', async () => {
      const storage = new LocalStorage();
      await expect(
        storage.put('backup-2024-01-01T00-00-00.db', '/tmp/test.db')
      ).resolves.toBeUndefined();
    });
  });

  describe('get', () => {
    it('should reject invalid filename', async () => {
      const storage = new LocalStorage();
      await expect(storage.get('../etc/passwd')).rejects.toThrow(
        'Invalid backup filename format'
      );
    });

    it('should return file contents for valid filename', async () => {
      const validFile = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00.db'
      );
      fs.writeFileSync(validFile, 'test content');

      const storage = new LocalStorage();
      const data = await storage.get('backup-2024-01-01T00-00-00.db');

      expect(data.toString()).toBe('test content');
    });
  });

  describe('delete', () => {
    it('should reject invalid filename', async () => {
      const storage = new LocalStorage();
      await expect(storage.delete('../etc/passwd')).rejects.toThrow(
        'Invalid backup filename format'
      );
    });

    it('should delete existing file', async () => {
      const filePath = path.join(
        testBackupDir,
        'backup-2024-01-01T00-00-00.db'
      );
      fs.writeFileSync(filePath, 'test content');
      expect(fs.existsSync(filePath)).toBe(true);

      const storage = new LocalStorage();
      await storage.delete('backup-2024-01-01T00-00-00.db');

      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should throw when file does not exist', async () => {
      const storage = new LocalStorage();
      await expect(
        storage.delete('backup-2024-01-01T00-00-00.db')
      ).rejects.toThrow();
    });
  });

  describe('list', () => {
    it('should return empty array for empty directory', async () => {
      const storage = new LocalStorage();
      const list = await storage.list();

      expect(list).toEqual([]);
    });

    it('should list valid backup files', async () => {
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-2024-01-01T00-00-00.db'),
        'a'
      );
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-2024-01-02T00-00-00.db'),
        'bb'
      );

      const storage = new LocalStorage();
      const list = await storage.list();

      expect(list).toHaveLength(2);
      expect(list[0].filename).toMatch(/^backup-2024-01-0[12]T00-00-00\.db$/);
      expect(list[1].filename).toMatch(/^backup-2024-01-0[12]T00-00-00\.db$/);
    });

    it('should exclude files with invalid format', async () => {
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-2024-01-01T00-00-00.db'),
        'valid'
      );
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-invalid.db'),
        'invalid'
      );
      fs.writeFileSync(path.join(testBackupDir, 'other-file.txt'), 'other');

      const storage = new LocalStorage();
      const list = await storage.list();

      expect(list).toHaveLength(1);
      expect(list[0].filename).toBe('backup-2024-01-01T00-00-00.db');
    });

    it('should sort by createdAt descending', async () => {
      const file1 = path.join(testBackupDir, 'backup-2024-01-01T00-00-00.db');
      const file2 = path.join(testBackupDir, 'backup-2024-01-03T00-00-00.db');
      fs.writeFileSync(file1, 'a');
      fs.writeFileSync(file2, 'b');

      const storage = new LocalStorage();
      const list = await storage.list();

      expect(list).toHaveLength(2);
      expect(list[0].createdAt.getTime()).toBeGreaterThanOrEqual(
        list[1].createdAt.getTime()
      );
    });

    it('should include path and size in results', async () => {
      fs.writeFileSync(
        path.join(testBackupDir, 'backup-2024-01-01T00-00-00.db'),
        'content'
      );

      const storage = new LocalStorage();
      const list = await storage.list();

      expect(list[0].path).toBe(
        path.join(testBackupDir, 'backup-2024-01-01T00-00-00.db')
      );
      expect(list[0].size).toBe(7);
    });
  });
});
