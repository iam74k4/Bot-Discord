import { randomBytes } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as cron from 'node-cron';
import { env } from '../../config/index.js';
import { database, databaseFilePath } from '../database/connection.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import {
  createBackupStorage,
  validateBackupFilename,
  type IBackupStorage,
} from './storage/index.js';
import {
  resolveSqliteDriver,
  snapshotInWorker,
  type SpawnSnapshotWorker,
} from './snapshot.js';

/**
 * Backup result information
 */
export interface BackupResult {
  success: boolean;
  filename: string;
  size: number;
  timestamp: Date;
  error?: string;
}

/**
 * Backup file information
 */
export interface BackupInfo {
  filename: string;
  path?: string;
  size: number;
  createdAt: Date;
}

export interface BackupServiceOptions {
  /** Where finished backups are kept. Defaults to the configured storage. */
  createStorage?: () => IBackupStorage;
  /** Starts the copy's worker thread. Tests substitute a fake. */
  spawnWorker?: SpawnSnapshotWorker;
  /** How long a copy may run before it is abandoned. */
  workerTimeoutMs?: number;
}

/** Suffix of a copy still being written; never matches a backup filename. */
const PARTIAL_SUFFIX = '.partial';

/**
 * A copy that never finished, and the rollback journal SQLite keeps beside
 * it while writing. Left behind when the process is killed mid-copy; each is
 * the size of the database, and nothing else would ever delete it.
 */
const UNFINISHED_COPY = /^backup-.*\.db\.partial(?:-journal)?$/;

/** Delete a file that may not exist, without failing the caller. */
async function removeQuietly(file: string): Promise<void> {
  try {
    await fsp.rm(file, { force: true });
  } catch (error) {
    logger.warn(`Could not remove ${file}:`, getErrorMessage(error));
  }
}

/** Write `data` to `file` and flush it to disk before returning. */
async function writeDurably(file: string, data: Buffer): Promise<void> {
  const handle = await fsp.open(file, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Backup service for database backups
 */
export class BackupService {
  private task: cron.ScheduledTask | null = null;
  private backupDirValue: string | null = null;
  private storageValue: IBackupStorage | null = null;
  private initialized: Promise<void> | null = null;
  /**
   * Backups and restores run one at a time. Two backups must not share a
   * path mid-write, and a restore must not close the connection and replace
   * the file while a backup worker still has it open.
   */
  private exclusiveChain: Promise<void> = Promise.resolve();
  private readonly options: BackupServiceOptions;

  /**
   * Stores the options and nothing else: the shared instance is created when
   * this module is imported, so config, storage, and the backup directory are
   * all set up on first use instead.
   */
  constructor(options: BackupServiceOptions = {}) {
    this.options = options;
  }

  /**
   * Read config and create the directory on first use, never on import.
   *
   * The constructor used to do both, which meant importing this module read
   * the environment and made a directory on disk - including in any test that
   * merely touched the admin panel.
   */
  private get backupDir(): string {
    this.backupDirValue ??= env.BACKUP_DIR;
    return this.backupDirValue;
  }

  private get storage(): IBackupStorage {
    this.storageValue ??= (this.options.createStorage ?? createBackupStorage)();
    return this.storageValue;
  }

  /**
   * Once per process, before the first copy or listing: create the directory
   * and clear out copies an earlier process never finished.
   *
   * Every copy waits for this, and copies run one at a time in this process,
   * so any unfinished copy found here belongs to a process that is gone.
   */
  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.ensureBackupDir().then(() =>
      this.removeUnfinishedCopies()
    );
    return this.initialized;
  }

  /**
   * Ensure backup directory exists (for local temp files)
   */
  private async ensureBackupDir(): Promise<void> {
    try {
      await fsp.mkdir(this.backupDir, { recursive: true });
    } catch (error) {
      logger.warn('Failed to create backup directory:', getErrorMessage(error));
    }
  }

  private async removeUnfinishedCopies(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this.backupDir);
    } catch (error) {
      logger.warn(
        'Could not check the backup directory for unfinished copies:',
        getErrorMessage(error)
      );
      return;
    }

    const unfinished = files.filter((file) => UNFINISHED_COPY.test(file));
    for (const file of unfinished) {
      await removeQuietly(path.join(this.backupDir, file));
    }
    if (unfinished.length > 0) {
      logger.info(
        `Removed ${unfinished.length} unfinished backup file(s) left by an earlier run`
      );
    }
  }

  /** Run `task` once every earlier backup or restore has finished. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.then(task);
    this.exclusiveChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Generate a unique backup filename (second + nonce).
   */
  private generateFilename(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nonce = randomBytes(3).toString('hex');
    return `backup-${timestamp}-${nonce}.db`;
  }

  /**
   * Run a database backup
   */
  async runBackup(): Promise<BackupResult> {
    return this.exclusive(() => this.runBackupExclusive());
  }

  /**
   * Copy the live database to `destination` without freezing the bot.
   *
   * A worker thread does the copy (see `snapshot.ts`). Only when no worker can
   * run at all does this fall back to the main connection's own backup, which
   * works everywhere but blocks the event loop at its final step. A copy that
   * started and then failed is not retried: the same disk or file problem
   * would fail it again, and the caller reports it.
   */
  private async copyDatabase(destination: string): Promise<void> {
    const outcome = await snapshotInWorker(
      {
        source: databaseFilePath(),
        destination,
        driver: resolveSqliteDriver(),
      },
      {
        spawn: this.options.spawnWorker,
        timeoutMs: this.options.workerTimeoutMs,
      }
    );

    if (outcome.status === 'done') return;
    if (outcome.status === 'failed') throw new Error(outcome.error);

    logger.warn(
      `Backup worker unavailable (${outcome.error}); copying on the main thread instead`
    );
    await removeQuietly(destination);
    await database.backup(destination);
  }

  private async runBackupExclusive(): Promise<BackupResult> {
    await this.ensureInitialized();
    const filename = this.generateFilename();
    const backupPath = path.join(this.backupDir, filename);
    // Written under a name listBackups() ignores and renamed once complete,
    // so a copy cut short - by an error or by the process being killed - is
    // never offered for restore.
    const partialPath = `${backupPath}${PARTIAL_SUFFIX}`;

    try {
      logger.info('Starting database backup...');

      try {
        await this.copyDatabase(partialPath);
        await fsp.rename(partialPath, backupPath);
      } catch (copyError) {
        await removeQuietly(partialPath);
        await removeQuietly(`${partialPath}-journal`);
        throw copyError;
      }

      const stats = await fsp.stat(backupPath);

      try {
        await this.storage.put(filename, backupPath);
      } catch (storageError) {
        const errorMessage =
          storageError instanceof Error
            ? storageError.message
            : 'Unknown error';
        logger.error('Storage upload failed:', errorMessage);

        return {
          success: false,
          filename,
          size: stats.size,
          timestamp: new Date(),
          error: errorMessage,
        };
      }

      logger.info(
        `Backup completed: ${filename} (${Math.round(stats.size / 1024)} KB)`
      );

      const deleted = await this.deleteOldBackups();
      if (deleted > 0) {
        logger.info(`Deleted ${deleted} old backup(s)`);
      }

      return {
        success: true,
        filename,
        size: stats.size,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('Backup failed:', errorMessage);

      return {
        success: false,
        filename,
        size: 0,
        timestamp: new Date(),
        error: errorMessage,
      };
    }
  }

  /**
   * List all backups
   */
  async listBackups(): Promise<BackupInfo[]> {
    await this.ensureInitialized();

    try {
      const files = await this.storage.list();

      return files.map((f) => ({
        filename: f.filename,
        path: f.path,
        size: f.size,
        createdAt: f.createdAt,
      }));
    } catch (error) {
      logger.error('Failed to list backups:', getErrorMessage(error));
      return [];
    }
  }

  /**
   * Delete backups older than retention period
   */
  async deleteOldBackups(): Promise<number> {
    const retentionMs = env.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - retentionMs);
    let deleted = 0;

    const backups = await this.listBackups();

    for (const backup of backups) {
      if (backup.createdAt < cutoffDate) {
        try {
          await this.storage.delete(backup.filename);
          deleted++;
          logger.debug(`Deleted old backup: ${backup.filename}`);
        } catch (error) {
          logger.warn(`Failed to delete backup ${backup.filename}:`, error);
        }
      }
    }

    return deleted;
  }

  /**
   * Restore from a backup file
   * WARNING: This will overwrite the current database
   *
   * Waits for any backup in progress, so the file is never replaced while a
   * backup worker still has it open.
   */
  async restore(
    filename: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!validateBackupFilename(filename)) {
      return { success: false, error: 'Invalid backup filename format' };
    }

    return this.exclusive(() => this.restoreExclusive(filename));
  }

  private async restoreExclusive(
    filename: string
  ): Promise<{ success: boolean; error?: string }> {
    const target = databaseFilePath();
    const staging = `${target}.restore`;
    let connectionClosed = false;

    try {
      let data: Buffer;

      const backups = await this.listBackups();
      const backup = backups.find((b) => b.filename === filename);

      if (backup?.path) {
        const resolvedPath = path.resolve(backup.path);
        const resolvedDir = path.resolve(this.backupDir);
        if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
          return { success: false, error: 'Invalid backup path' };
        }
        data = await fsp.readFile(backup.path);
      } else {
        data = await this.storage.get(filename);
      }

      logger.warn(`Restoring database from backup: ${filename}`);

      // Written beside the target before anything else is touched. If this
      // fails - a full disk, typically - the bot carries on with its own
      // database, connection, and WAL exactly as they were. The rename below
      // then swaps the file in one step, so a crash leaves either the old
      // database or the restored one, never half of each.
      try {
        await writeDurably(staging, data);
      } catch (writeError) {
        await removeQuietly(staging);
        throw writeError;
      }

      database.close();
      connectionClosed = true;

      // Closing the last connection normally folds the WAL into the file and
      // deletes it. Were one left behind, SQLite would replay its frames -
      // pages of the database being replaced - over the restored file on the
      // next start.
      await removeQuietly(`${target}-wal`);
      await removeQuietly(`${target}-shm`);
      await fsp.rename(staging, target);

      logger.info(
        'Database restored successfully. Process will exit — restart the bot to use the restored database.'
      );

      setTimeout(() => process.exit(0), 1000);

      return { success: true };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      logger.error('Restore failed:', errorMessage);
      if (connectionClosed) {
        // Nothing works on a closed connection; restart on whichever file is
        // in place rather than keep running without a database.
        await removeQuietly(staging);
        logger.error(
          'The database connection is already closed; exiting so the bot restarts.'
        );
        setTimeout(() => process.exit(1), 1000);
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Start scheduled backup job
   */
  start(): void {
    if (this.task) {
      logger.warn('Backup service already running');
      return;
    }

    this.task = cron.schedule(
      env.BACKUP_CRON,
      async () => {
        await this.runBackup();
      },
      {
        timezone: env.TZ || 'UTC',
      }
    );

    logger.info(`Backup service started (schedule: ${env.BACKUP_CRON})`);
  }

  /**
   * Stop scheduled backup job
   */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Backup service stopped');
    }
  }

  /**
   * Check if backup service is running
   */
  isRunning(): boolean {
    return this.task !== null;
  }
}

export const backupService = new BackupService();
