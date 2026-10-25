import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../../config/index.js';
import { sendAlert } from '../../shared/utils/alert.js';
import { getErrorMessage, logger } from '../../shared/utils/logger.js';
import { validateBackupFilename } from './storage/index.js';

/**
 * Restore the database from one of its backups, at startup, exactly once.
 *
 * Replacing the database file under a running bot corrupts it, and on Railway
 * there is no moment when the bot is stopped but its volume is reachable. So
 * the swap happens here, before anything opens the database: set
 * RESTORE_BACKUP to a backup's filename (as `/owner system` lists them) and
 * redeploy.
 *
 * - The backup must pass SQLite's integrity check, or nothing is touched.
 * - The database being replaced is kept as a backup of its own, in the same
 *   directory and format, so a restore can be undone by restoring that.
 * - A marker records the restored filename, so leaving the variable set does
 *   not restore the same backup again on every restart and wipe what was
 *   written since.
 */

export type RestoreOutcome =
  | { status: 'not-requested' }
  | { status: 'already-restored'; filename: string }
  | { status: 'restored'; filename: string; previous: string | null }
  | { status: 'failed'; filename: string; reason: string };

export interface RestorePaths {
  /** Absolute path of the live database file. */
  databasePath: string;
  /** Absolute path of the backup directory. */
  backupDir: string;
}

/** Records the last backup restored; lives next to the backups. */
export const RESTORE_MARKER = '.last-restore.json';

function markerPath(paths: RestorePaths): string {
  return join(paths.backupDir, RESTORE_MARKER);
}

function lastRestored(paths: RestorePaths): string | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath(paths), 'utf-8')) as {
      filename?: unknown;
    };
    return typeof marker.filename === 'string' ? marker.filename : null;
  } catch {
    return null;
  }
}

/** Same shape as the scheduled backups, so it is listed, kept and pruned. */
function backupFilename(now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `backup-${timestamp}-${randomBytes(3).toString('hex')}.db`;
}

function integrityProblem(file: string): string | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    const result = rows.map((row) => row.integrity_check).join('; ');
    return result === 'ok' ? null : result;
  } catch (error) {
    return getErrorMessage(error);
  } finally {
    db?.close();
  }
}

/**
 * Save the live database (main file plus its WAL) as one self-contained
 * backup file. Returns its filename, or null when there is no database yet.
 */
function preserveCurrent(paths: RestorePaths, now: Date): string | null {
  if (!existsSync(paths.databasePath)) return null;

  const filename = backupFilename(now);
  const target = join(paths.backupDir, filename);
  const staging = `${target}.saving`;
  const removeStaging = () => {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${staging}${suffix}`, { force: true });
    }
  };
  try {
    copyFileSync(paths.databasePath, staging);
    if (existsSync(`${paths.databasePath}-wal`)) {
      copyFileSync(`${paths.databasePath}-wal`, `${staging}-wal`);
    }
  } catch (error) {
    removeStaging();
    throw error;
  }

  // Folding the WAL in makes the copy a single file like every other backup.
  // A database too damaged to open is kept as it is; that may be why it is
  // being replaced.
  try {
    const db = new Database(staging, { fileMustExist: true });
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      // Back to a rollback journal, so opening the copy later (even read-only)
      // does not grow a -wal beside it. Reopened as the live database, the
      // connection switches it to WAL again.
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn(
      `Could not fold the WAL into ${filename}; keeping the raw copy:`,
      getErrorMessage(error)
    );
  }
  renameSync(staging, target);
  removeStaging();
  return filename;
}

export function restoreBackupIfRequested(
  filename: string,
  paths: RestorePaths,
  now: Date = new Date()
): RestoreOutcome {
  if (!filename) return { status: 'not-requested' };

  if (!validateBackupFilename(filename)) {
    return {
      status: 'failed',
      filename,
      reason:
        'not a backup filename (expected backup-YYYY-MM-DDTHH-MM-SS-xxxxxx.db)',
    };
  }
  if (lastRestored(paths) === filename) {
    return { status: 'already-restored', filename };
  }

  const source = join(paths.backupDir, filename);
  if (!existsSync(source)) {
    return {
      status: 'failed',
      filename,
      reason: `no such backup in ${paths.backupDir}`,
    };
  }
  const problem = integrityProblem(source);
  if (problem) {
    return {
      status: 'failed',
      filename,
      reason: `integrity check failed: ${problem}`,
    };
  }

  // Stage the copy first: until the rename below, a failure leaves the live
  // database exactly as it was.
  const staged = `${paths.databasePath}.restoring`;
  let previous: string | null;
  try {
    copyFileSync(source, staged);
    previous = preserveCurrent(paths, now);
  } catch (error) {
    rmSync(staged, { force: true });
    return { status: 'failed', filename, reason: getErrorMessage(error) };
  }

  // The old WAL belongs to the old database: left in place, SQLite would
  // replay it into the restored one. It is saved in `previous`.
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${paths.databasePath}${suffix}`, { force: true });
  }
  renameSync(staged, paths.databasePath);

  try {
    writeFileSync(
      markerPath(paths),
      JSON.stringify({ filename, restoredAt: now.toISOString(), previous }) +
        '\n'
    );
  } catch (error) {
    // The restore itself succeeded; without the marker the next start would
    // restore the same backup again over anything written in between.
    logger.error(
      `Restored ${filename} but could not record it; delete RESTORE_BACKUP now or the next start restores it again:`,
      getErrorMessage(error)
    );
  }
  return { status: 'restored', filename, previous };
}

/**
 * The startup step: restore if RESTORE_BACKUP asks for it, and say what
 * happened. A failed restore leaves the database alone and the bot keeps
 * running on it - an outage would be worse - but it is logged as an error and
 * sent to the alert webhook so it cannot pass unnoticed.
 */
export function restoreOnStartup(config: AppConfig): void {
  const paths: RestorePaths = {
    databasePath: join(process.cwd(), config.DATABASE_PATH),
    backupDir: join(process.cwd(), config.BACKUP_DIR),
  };
  let outcome: RestoreOutcome;
  try {
    outcome = restoreBackupIfRequested(config.RESTORE_BACKUP, paths);
  } catch (error) {
    outcome = {
      status: 'failed',
      filename: config.RESTORE_BACKUP,
      reason: getErrorMessage(error),
    };
  }

  switch (outcome.status) {
    case 'not-requested':
      return;
    case 'already-restored':
      logger.warn(
        `RESTORE_BACKUP=${outcome.filename} was already restored; remove the variable.`
      );
      return;
    case 'restored':
      logger.warn(
        `Restored the database from ${outcome.filename}.` +
          (outcome.previous
            ? ` The database it replaced is saved as ${outcome.previous}; restore that to undo.`
            : '') +
          ' Remove RESTORE_BACKUP.'
      );
      return;
    case 'failed':
      logger.error(
        `RESTORE_BACKUP=${outcome.filename} was not restored (${outcome.reason}); starting with the current database.`
      );
      void sendAlert(
        'Database restore failed',
        `RESTORE_BACKUP=${outcome.filename} was not restored: ${outcome.reason}. The bot started with the current database.`
      ).catch(() => undefined);
      return;
  }
}
