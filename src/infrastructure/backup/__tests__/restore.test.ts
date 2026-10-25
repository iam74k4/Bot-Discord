import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../config/index.js';
import {
  RESTORE_MARKER,
  restoreBackupIfRequested,
  restoreOnStartup,
  type RestorePaths,
} from '../restore.js';

const { logger, sendAlert } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../../../shared/utils/alert.js', () => ({ sendAlert }));

/**
 * Real SQLite files in a temp directory: the point of a restore is what ends
 * up on disk, including rows that only ever reached the write-ahead log.
 */

const BACKUP = 'backup-2026-10-25T04-00-00-abcdef.db';
const NOW = new Date('2026-10-25T09:30:00.000Z');

let dir: string;
let paths: RestorePaths;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'restore-'));
  paths = {
    databasePath: join(dir, 'bot.db'),
    backupDir: join(dir, 'backups'),
  };
  mkdirSync(paths.backupDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDatabase(file: string, rows: string[]): void {
  const db = new Database(file);
  db.exec('CREATE TABLE notes (text TEXT)');
  const insert = db.prepare('INSERT INTO notes VALUES (?)');
  for (const row of rows) insert.run(row);
  db.close();
}

function rowsOf(file: string): string[] {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.prepare('SELECT text FROM notes').all() as Array<{ text: string }>
    ).map((row) => row.text);
  } finally {
    db.close();
  }
}

/** The live database as a crash would leave it: a row only in the WAL. */
function makeLiveDatabaseWithWal(rows: string[], walOnly: string): void {
  const scratch = join(dir, 'scratch.db');
  const db = new Database(scratch);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE notes (text TEXT)');
  const insert = db.prepare('INSERT INTO notes VALUES (?)');
  for (const row of rows) insert.run(row);
  db.pragma('wal_checkpoint(TRUNCATE)');
  insert.run(walOnly);
  // Copy while the connection is open, so the WAL is not folded in on close.
  copyFileSync(scratch, paths.databasePath);
  copyFileSync(`${scratch}-wal`, `${paths.databasePath}-wal`);
  db.close();
}

function backupsIn(): string[] {
  return readdirSync(paths.backupDir).filter(
    (f) => f.startsWith('backup-') && f.endsWith('.db')
  );
}

describe('restoreBackupIfRequested', () => {
  it('does nothing when no backup is requested', () => {
    makeDatabase(paths.databasePath, ['live']);

    expect(restoreBackupIfRequested('', paths, NOW)).toEqual({
      status: 'not-requested',
    });
    expect(rowsOf(paths.databasePath)).toEqual(['live']);
  });

  it.each([
    ['a path', '../bot.db'],
    ['a plain database name', 'bot.db'],
    ['a backup name with a directory', `backups/${BACKUP}`],
  ])('refuses %s and leaves the database alone', (_label, name) => {
    makeDatabase(paths.databasePath, ['live']);

    const outcome = restoreBackupIfRequested(name, paths, NOW);

    expect(outcome).toMatchObject({ status: 'failed', filename: name });
    expect(rowsOf(paths.databasePath)).toEqual(['live']);
  });

  it('refuses a backup that does not exist', () => {
    makeDatabase(paths.databasePath, ['live']);

    expect(restoreBackupIfRequested(BACKUP, paths, NOW)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('no such backup'),
    });
    expect(rowsOf(paths.databasePath)).toEqual(['live']);
  });

  it('refuses a backup that fails the integrity check, touching nothing', () => {
    makeDatabase(paths.databasePath, ['live']);
    writeFileSync(join(paths.backupDir, BACKUP), 'not a database at all');

    expect(restoreBackupIfRequested(BACKUP, paths, NOW)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('integrity check failed'),
    });
    expect(rowsOf(paths.databasePath)).toEqual(['live']);
    expect(backupsIn()).toEqual([BACKUP]);
    expect(existsSync(join(paths.backupDir, RESTORE_MARKER))).toBe(false);
  });

  it('replaces the database and keeps the one it replaced, WAL included, as a backup', () => {
    makeLiveDatabaseWithWal(['live'], 'only-in-wal');
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);

    const outcome = restoreBackupIfRequested(BACKUP, paths, NOW);

    expect(outcome).toMatchObject({ status: 'restored', filename: BACKUP });
    const previous = (outcome as { previous: string }).previous;
    expect(previous).toMatch(/^backup-2026-10-25T09-30-00-[0-9a-f]{6}\.db$/);
    expect(rowsOf(paths.databasePath)).toEqual(['from-backup']);
    // The old WAL would otherwise be replayed into the restored database.
    expect(existsSync(`${paths.databasePath}-wal`)).toBe(false);
    // The saved copy is a single self-contained file holding every old row.
    expect(existsSync(join(paths.backupDir, `${previous}-wal`))).toBe(false);
    expect(rowsOf(join(paths.backupDir, previous))).toEqual([
      'live',
      'only-in-wal',
    ]);
    expect(
      JSON.parse(readFileSync(join(paths.backupDir, RESTORE_MARKER), 'utf-8'))
    ).toEqual({
      filename: BACKUP,
      restoredAt: NOW.toISOString(),
      previous,
    });
  });

  it('does not restore the same backup again while the variable stays set', () => {
    makeDatabase(paths.databasePath, ['live']);
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);
    restoreBackupIfRequested(BACKUP, paths, NOW);
    const db = new Database(paths.databasePath);
    db.prepare('INSERT INTO notes VALUES (?)').run('written-after-restore');
    db.close();

    expect(restoreBackupIfRequested(BACKUP, paths, NOW)).toEqual({
      status: 'already-restored',
      filename: BACKUP,
    });
    expect(rowsOf(paths.databasePath)).toEqual([
      'from-backup',
      'written-after-restore',
    ]);
  });

  it('undoes a restore by restoring the backup it saved', () => {
    makeDatabase(paths.databasePath, ['live']);
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);
    const first = restoreBackupIfRequested(BACKUP, paths, NOW) as {
      previous: string;
    };

    const undo = restoreBackupIfRequested(
      first.previous,
      paths,
      new Date('2026-10-25T09:31:00Z')
    );

    expect(undo).toMatchObject({
      status: 'restored',
      filename: first.previous,
    });
    expect(rowsOf(paths.databasePath)).toEqual(['live']);
  });

  it('restores over a database too damaged to open, keeping the raw copy', () => {
    writeFileSync(paths.databasePath, 'corrupted beyond repair');
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);

    const outcome = restoreBackupIfRequested(BACKUP, paths, NOW);

    expect(outcome).toMatchObject({ status: 'restored', filename: BACKUP });
    const previous = (outcome as { previous: string }).previous;
    expect(rowsOf(paths.databasePath)).toEqual(['from-backup']);
    expect(readFileSync(join(paths.backupDir, previous), 'utf-8')).toBe(
      'corrupted beyond repair'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `Could not fold the WAL into ${previous}; keeping the raw copy:`,
      expect.any(String)
    );
  });

  it('still restores, and says how to stop a repeat, when the marker cannot be written', () => {
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);
    // A directory where the marker file should go makes the write fail.
    mkdirSync(join(paths.backupDir, RESTORE_MARKER));

    expect(restoreBackupIfRequested(BACKUP, paths, NOW)).toMatchObject({
      status: 'restored',
    });
    expect(rowsOf(paths.databasePath)).toEqual(['from-backup']);
    expect(logger.error).toHaveBeenCalledWith(
      `Restored ${BACKUP} but could not record it; delete RESTORE_BACKUP now or the next start restores it again:`,
      expect.any(String)
    );
  });

  it('restores onto a fresh volume with no database yet', () => {
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);

    expect(restoreBackupIfRequested(BACKUP, paths, NOW)).toEqual({
      status: 'restored',
      filename: BACKUP,
      previous: null,
    });
    expect(rowsOf(paths.databasePath)).toEqual(['from-backup']);
  });
});

describe('restoreOnStartup', () => {
  function config(restore: string): AppConfig {
    return {
      RESTORE_BACKUP: restore,
      DATABASE_PATH: relative(process.cwd(), paths.databasePath),
      BACKUP_DIR: relative(process.cwd(), paths.backupDir),
    } as AppConfig;
  }

  it('stays silent when no restore is requested', () => {
    restoreOnStartup(config(''));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('says what it restored and how to undo it', () => {
    makeDatabase(paths.databasePath, ['live']);
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);

    restoreOnStartup(config(BACKUP));

    expect(rowsOf(paths.databasePath)).toEqual(['from-backup']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^Restored the database from ${BACKUP}\\. The database it replaced is saved as backup-.*\\.db; restore that to undo\\. Remove RESTORE_BACKUP\\.$`
        )
      )
    );
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('asks for the variable to be removed once the restore is done', () => {
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);
    restoreOnStartup(config(BACKUP));
    vi.clearAllMocks();

    restoreOnStartup(config(BACKUP));

    expect(logger.warn).toHaveBeenCalledWith(
      `RESTORE_BACKUP=${BACKUP} was already restored; remove the variable.`
    );
  });

  it('treats an unexpected error as a failed restore instead of crashing startup', () => {
    makeDatabase(join(paths.backupDir, BACKUP), ['from-backup']);
    // The live database path is a directory: staging succeeds, the swap throws.
    mkdirSync(paths.databasePath);
    writeFileSync(join(paths.databasePath, 'keep'), '');

    expect(() => restoreOnStartup(config(BACKUP))).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`RESTORE_BACKUP=${BACKUP} was not restored (`)
    );
    expect(sendAlert).toHaveBeenCalledWith(
      'Database restore failed',
      expect.any(String)
    );
  });

  it('logs and alerts a failed restore, then lets the bot start on the current database', () => {
    makeDatabase(paths.databasePath, ['live']);

    expect(() => restoreOnStartup(config(BACKUP))).not.toThrow();

    expect(rowsOf(paths.databasePath)).toEqual(['live']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `RESTORE_BACKUP=${BACKUP} was not restored (no such backup`
      )
    );
    expect(sendAlert).toHaveBeenCalledWith(
      'Database restore failed',
      expect.stringContaining('The bot started with the current database.')
    );
  });
});
