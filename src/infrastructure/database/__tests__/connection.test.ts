import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises the real connection module against a throwaway file database.
 * `process.cwd()` is pointed at a temp directory so the configured relative
 * DATABASE_PATH never resolves into the repository's data/ folder.
 */
const DATABASE_PATH = join('nested', 'data', 'bot.db');

vi.mock('../../../config/index.js', () => ({
  env: { DATABASE_PATH: join('nested', 'data', 'bot.db') },
}));

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => String(e),
}));

const { closeDatabase, database, databaseFilePath, getTableCount } =
  await import('../connection.js');

let workDir: string;

function dbFile(): string {
  return join(workDir, DATABASE_PATH);
}

function debugMessages(): unknown[] {
  return logger.debug.mock.calls.map((call: unknown[]) => call[0]);
}

describe('database connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workDir = mkdtempSync(join(tmpdir(), 'bot-db-connection-'));
    vi.spyOn(process, 'cwd').mockReturnValue(workDir);
  });

  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('does not open anything until the database is first used', () => {
    expect(existsSync(dbFile())).toBe(false);
    expect(logger.debug).not.toHaveBeenCalled();

    expect(getTableCount()).toBe(0);

    expect(existsSync(dbFile())).toBe(true);
    expect(debugMessages()).toEqual(['Database connection opened']);
  });

  it('creates the missing data directory under the working directory', () => {
    expect(existsSync(join(workDir, 'nested'))).toBe(false);

    database.exec('SELECT 1');

    expect(existsSync(join(workDir, 'nested', 'data'))).toBe(true);
  });

  it('uses an existing data directory as is', () => {
    mkdirSync(join(workDir, 'nested', 'data'), { recursive: true });

    database.exec('CREATE TABLE t (x INTEGER)');

    expect(getTableCount()).toBe(1);
    expect(existsSync(dbFile())).toBe(true);
  });

  it('switches the journal to WAL', () => {
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('syncs at checkpoints (NORMAL) from the start rather than on every commit', () => {
    // A fresh WAL connection reports FULL (2) until SQLite applies its
    // build-time WAL default on the first transaction. Stating NORMAL (1)
    // means no commit on the voice path ever waits for an fsync.
    expect(database.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('names the file it opens, for the backup worker and restore', () => {
    expect(databaseFilePath()).toBe(dbFile());
    expect(database.name).toBe(databaseFilePath());
  });

  it('shares one connection between the proxy and getTableCount', () => {
    database.exec('CREATE TABLE a (x INTEGER)');
    database.exec('CREATE TABLE b (x INTEGER)');

    expect(getTableCount()).toBe(2);
    expect(debugMessages()).toEqual(['Database connection opened']);
  });

  it('binds methods so they work when detached from the proxy', () => {
    const { prepare } = database;

    expect(prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
  });

  it('passes plain properties through from the connection', () => {
    expect(database.open).toBe(true);
    expect(database.memory).toBe(false);
    expect(database.name).toBe(dbFile());
  });

  it('closes the connection once and reopens it on the next use', () => {
    database.exec('CREATE TABLE kept (x INTEGER)');

    closeDatabase();
    closeDatabase();

    expect(debugMessages()).toEqual([
      'Database connection opened',
      'Database connection closed',
    ]);

    // Data written before the close is on disk for the new connection.
    expect(getTableCount()).toBe(1);
    expect(debugMessages()).toEqual([
      'Database connection opened',
      'Database connection closed',
      'Database connection opened',
    ]);
  });

  it('refreshes planner statistics for the tables it queried before closing', () => {
    database.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    database.exec('CREATE INDEX t_a ON t (a)');
    const insert = database.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
    database.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run(i % 50, 'x');
    })();
    database.prepare('SELECT * FROM t WHERE a = ?').all(3);

    closeDatabase();

    expect(
      database.prepare("SELECT idx FROM sqlite_stat1 WHERE tbl = 't'").all()
    ).toEqual([{ idx: 't_a' }]);
  });

  it('still closes the connection when optimizing fails', () => {
    // exec() returns the connection itself, so its own pragma can fail.
    const connection = database.exec('SELECT 1');
    const pragma = connection.pragma.bind(connection);
    vi.spyOn(connection, 'pragma').mockImplementation((source, options) => {
      if (source === 'optimize')
        throw new Error('attempt to write a readonly database');
      return pragma(source, options);
    });

    closeDatabase();

    expect(connection.open).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      'PRAGMA optimize before close was skipped:',
      expect.objectContaining({
        message: 'attempt to write a readonly database',
      })
    );
    expect(debugMessages()).toContain('Database connection closed');
  });

  it('does nothing when closing a connection that was never opened', () => {
    closeDatabase();

    expect(logger.debug).not.toHaveBeenCalled();
  });
});
