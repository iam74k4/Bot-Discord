import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexNames, proxyDatabase } from './infrastructure.helpers.js';

/**
 * 012 trades indexes nobody read for the one the audit log view needs. Two
 * things can quietly undo that: an earlier migration that still creates a
 * dropped index (every boot would rebuild it, then 012 would drop it again),
 * and a query the new index does not actually serve.
 */
let db: DatabaseType = new Database(':memory:');

vi.mock('../connection.js', () => ({
  database: proxyDatabase(() => db),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{3}_.*\.ts$/.test(file))
  .sort();

async function runMigrationFiles(files: string[]): Promise<void> {
  for (const file of files) {
    const mod = (await import(
      pathToFileURL(join(MIGRATIONS_DIR, file)).href
    )) as { up: () => void };
    mod.up();
  }
}

const { SUPERSEDED_INDEXES } =
  await import('../migrations/012_query_indexes.js');
const { auditRepository } = await import('../../audit/auditRepository.js');

const NOW = new Date('2026-06-01T00:00:00Z').getTime();

/** The detail lines of SQLite's plan for `sql`, joined for matching. */
function planOf(sql: string, ...params: unknown[]): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  )
    .map((step) => step.detail)
    .join('\n');
}

/** Run `call` and return the SQL text it prepared. */
function sqlPreparedBy(call: () => unknown): string {
  const prepare = vi.spyOn(db, 'prepare');
  try {
    call();
    const statements = prepare.mock.calls.map(([sql]) => sql);
    expect(statements).toHaveLength(1);
    return statements[0];
  } finally {
    prepare.mockRestore();
  }
}

describe('012 query indexes', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('drops only indexes that no earlier migration creates again on the next boot', async () => {
    const earlier = MIGRATION_FILES.filter((file) => file < '012');
    expect(earlier.length).toBeGreaterThan(0);

    await runMigrationFiles(earlier);

    const names = indexNames(db);
    for (const name of SUPERSEDED_INDEXES) {
      expect(names).not.toContain(name);
    }
  });

  describe('the audit log view', () => {
    beforeEach(async () => {
      await runMigrationFiles(MIGRATION_FILES);
      vi.useFakeTimers();
    });

    function logAt(at: number, guildId: string, details: string): void {
      vi.setSystemTime(at);
      auditRepository.createLog(
        guildId,
        'u1',
        'SETTINGS_CHANGE',
        undefined,
        details
      );
    }

    it('reads a page of one guild newest first without sorting the guild', () => {
      const sql = sqlPreparedBy(() => auditRepository.getLogs('g1', 50, 0));

      const plan = planOf(sql, 'g1', 50, 0);

      expect(plan).toContain('idx_audit_logs_guild_created');
      expect(plan).not.toContain('TEMP B-TREE');
    });

    it('returns the same page the old sort did: newest first, ties by id, one guild', () => {
      logAt(NOW - 3_000, 'g1', 'oldest');
      logAt(NOW, 'g1', 'tie-first');
      logAt(NOW - 1_000, 'g2', 'other guild');
      logAt(NOW, 'g1', 'tie-second');
      logAt(NOW - 2_000, 'g1', 'middle');

      expect(
        auditRepository.getLogs('g1', 3, 0).map((row) => row.details)
      ).toEqual(['tie-second', 'tie-first', 'middle']);
      expect(
        auditRepository.getLogs('g1', 3, 3).map((row) => row.details)
      ).toEqual(['oldest']);
    });

    it('counts a guild from the index alone', () => {
      const sql = sqlPreparedBy(() => auditRepository.getLogsCount('g1'));

      expect(planOf(sql, 'g1')).toContain(
        'COVERING INDEX idx_audit_logs_guild_created'
      );
    });

    it('keeps the created_at index the retention purge walks', () => {
      const sql = sqlPreparedBy(() => auditRepository.deleteOldLogs(90));

      expect(planOf(sql, NOW)).toContain('idx_audit_logs_created_at');
    });
  });
});
