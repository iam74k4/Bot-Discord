import * as fsp from 'fs/promises';
import * as path from 'path';
import { env } from '../../../config/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import type { BackupFileInfo, IBackupStorage } from './types.js';
import { validateBackupFilename } from './types.js';

/**
 * Local filesystem storage for backups
 */
export class LocalStorage implements IBackupStorage {
  /**
   * Read on use, not in the constructor: the backup service is created when
   * its module is imported, and reading a setting then would validate the
   * whole configuration as a side effect of an import.
   */
  private get backupDir(): string {
    return env.BACKUP_DIR;
  }

  /**
   * Ensure backup directory exists
   */
  private async ensureDir(): Promise<void> {
    try {
      await fsp.mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      logger.warn('Failed to create backup directory:', getErrorMessage(error));
    }
  }

  /**
   * Put file - no-op for local storage (file is already written by database.backup).
   *
   * @param filename - Backup filename to validate
   * @param _localPath - Unused; file already exists at the target location
   * @throws Error if filename format is invalid
   */
  async put(filename: string, _localPath: string): Promise<void> {
    if (!validateBackupFilename(filename)) {
      throw new Error('Invalid backup filename format');
    }
  }

  /**
   * Get file contents from the local backup directory.
   *
   * @param filename - Backup filename to read
   * @returns File contents as a Buffer
   * @throws Error if filename is invalid, path traversal is detected, or file not found
   */
  async get(filename: string): Promise<Buffer> {
    if (!validateBackupFilename(filename)) {
      throw new Error('Invalid backup filename format');
    }
    const filePath = path.join(this.backupDir, filename);
    const resolvedPath = path.resolve(filePath);
    const resolvedDir = path.resolve(this.backupDir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
      throw new Error('Invalid backup path');
    }
    return fsp.readFile(filePath);
  }

  /**
   * List all backup files in the local directory.
   *
   * @returns Array of backup file info sorted by createdAt descending
   */
  async list(): Promise<BackupFileInfo[]> {
    await this.ensureDir();

    try {
      const files = await fsp.readdir(this.backupDir);
      const backups: BackupFileInfo[] = [];

      for (const file of files) {
        if (validateBackupFilename(file)) {
          const filePath = path.join(this.backupDir, file);
          const stats = await fsp.stat(filePath);

          backups.push({
            filename: file,
            size: stats.size,
            createdAt: stats.mtime,
            path: filePath,
          });
        }
      }

      return backups.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      );
    } catch (error) {
      logger.error('Failed to list backups:', getErrorMessage(error));
      return [];
    }
  }

  /**
   * Delete a backup file from the local directory.
   *
   * @param filename - Backup filename to delete
   * @throws Error if filename is invalid, path traversal is detected, or file not found
   */
  async delete(filename: string): Promise<void> {
    if (!validateBackupFilename(filename)) {
      throw new Error('Invalid backup filename format');
    }
    const filePath = path.join(this.backupDir, filename);
    const resolvedPath = path.resolve(filePath);
    const resolvedDir = path.resolve(this.backupDir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
      throw new Error('Invalid backup path');
    }
    await fsp.unlink(filePath);
  }
}
