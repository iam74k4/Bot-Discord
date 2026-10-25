import Database, { Database as DatabaseType } from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { logger } from '../../shared/utils/logger.js';
import { env } from '../../config/index.js';

let db: DatabaseType | null = null;

/**
 * Absolute path of the database file.
 *
 * `DATABASE_PATH` is validated to stay relative to the workspace, so this is
 * the one place that anchors it to `process.cwd()`. The backup worker and
 * `restore()` use it too, so they always read and replace the file this
 * connection has open.
 */
export function databaseFilePath(): string {
  return join(process.cwd(), env.DATABASE_PATH);
}

function getDb(): DatabaseType {
  if (!db) {
    const dbPath = databaseFilePath();
    const dataDir = dirname(dbPath);

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Stated rather than inherited: better-sqlite3 happens to build SQLite
    // with a WAL default of NORMAL. In WAL mode NORMAL keeps the database
    // consistent across a crash and only syncs at checkpoints, while FULL
    // would sync on every commit - several times slower on the voice
    // join/leave path, which runs on the main thread.
    db.pragma('synchronous = NORMAL');
    logger.debug('Database connection opened');
  }
  return db;
}

/**
 * Close the connection; the next use opens a fresh one.
 *
 * Runs `PRAGMA optimize` first, as SQLite recommends for a connection that is
 * about to close: it refreshes planner statistics for the tables this process
 * queried, and only where they are missing or out of date. The first run on a
 * large database can take about 100 ms, which is why it happens here at
 * shutdown and never on a timer. A failure (a read-only volume, a connection
 * `restore()` already closed) must not keep the connection open, so it is only
 * logged.
 */
export function closeDatabase(): void {
  if (db) {
    try {
      db.pragma('optimize');
    } catch (error) {
      logger.debug('PRAGMA optimize before close was skipped:', error);
    }
    db.close();
    db = null;
    logger.debug('Database connection closed');
  }
}

export function getTableCount(): number {
  const result = getDb()
    .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'")
    .get() as { count: number } | undefined;
  return result?.count ?? 0;
}

/**
 * Lazily-initialized database instance.
 * Access via this proxy; the actual connection is created on first use.
 */
export const database: DatabaseType = new Proxy({} as DatabaseType, {
  get(_target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, receiver);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
});
