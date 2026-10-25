import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAdminTables,
  insertAuditLogs,
  migrateAdminSchema,
} from './admin.helpers.js';

/**
 * The owner DB view counts rows by table name, and that name is interpolated
 * into SQL. The whitelist is the only thing standing between it and arbitrary
 * SQL, so it is tested alongside the counting itself on real SQLite.
 */

const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { databaseStatsRepository } =
  await import('../repositories/databaseStatsRepository.js');
const { logger } = await import('../../../shared/utils/logger.js');

describe('databaseStatsRepository.getTableRowCount', () => {
  beforeAll(async () => {
    await migrateAdminSchema();
  });

  beforeEach(() => {
    clearAdminTables(db);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('counts the rows of a whitelisted table', () => {
    insertAuditLogs(db, 4);

    expect(databaseStatsRepository.getTableRowCount('audit_logs')).toBe(4);
  });

  it('returns 0, not null, for an empty whitelisted table', () => {
    expect(databaseStatsRepository.getTableRowCount('voice_sessions')).toBe(0);
  });

  it.each([
    'polls',
    'sqlite_master',
    'audit_logs; DROP TABLE audit_logs',
    'AUDIT_LOGS',
    '',
  ])('refuses %j without touching the database', (name) => {
    const prepare = vi.spyOn(db, 'prepare');

    expect(databaseStatsRepository.getTableRowCount(name)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns null and warns when a whitelisted table is missing', () => {
    db.exec('ALTER TABLE notification_channels RENAME TO nc_backup');
    try {
      expect(
        databaseStatsRepository.getTableRowCount('notification_channels')
      ).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'getTableRowCount failed for notification_channels'
        )
      );
    } finally {
      db.exec('ALTER TABLE nc_backup RENAME TO notification_channels');
    }
  });
});
