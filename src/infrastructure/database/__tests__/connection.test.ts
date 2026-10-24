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

const { closeDatabase, database, getTableCount } =
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

  it('does nothing when closing a connection that was never opened', () => {
    closeDatabase();

    expect(logger.debug).not.toHaveBeenCalled();
  });
});
