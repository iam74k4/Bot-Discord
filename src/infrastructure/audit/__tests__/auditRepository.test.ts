import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proxyDatabase } from '../../database/__tests__/infrastructure.helpers.js';

/**
 * Runs against real SQLite with the real migrations, because what matters
 * here is the SQL: guild scoping, ordering, the default page size, and the
 * retention cutoff boundary.
 */
let db: DatabaseType = new Database(':memory:');

vi.mock('../../database/connection.js', () => ({
  database: proxyDatabase(() => db),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { auditRepository } = await import('../auditRepository.js');
const { guildSettingsRepository } =
  await import('../../guildSettings/index.js');
const migrations = await Promise.all([
  import('../../database/migrations/003_settings.js'),
  import('../../database/migrations/007_voice_autojoin.js'),
  import('../../database/migrations/008_announcement_channel.js'),
]);

const NOW = new Date('2026-06-01T00:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

/** Write a log as if it happened at `at`. */
function logAt(at: number, guildId = 'g1', details = `at ${at}`): void {
  vi.setSystemTime(at);
  auditRepository.createLog(
    guildId,
    'u1',
    'SETTINGS_CHANGE',
    undefined,
    details
  );
}

describe('auditRepository', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    for (const migration of migrations) migration.up();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe('createLog', () => {
    it('stores every field with the current time', () => {
      auditRepository.createLog('g1', 'u1', 'ROLE_ADD', 't1', 'Role: Member');

      expect(auditRepository.getLogs('g1')).toEqual([
        {
          id: 1,
          guild_id: 'g1',
          user_id: 'u1',
          action: 'ROLE_ADD',
          target_id: 't1',
          details: 'Role: Member',
          created_at: NOW,
        },
      ]);
    });

    it('stores NULL for an omitted target and details', () => {
      auditRepository.createLog('g1', 'u1', 'NOTIFY_ENABLE');

      expect(auditRepository.getLogs('g1')[0]).toMatchObject({
        action: 'NOTIFY_ENABLE',
        target_id: null,
        details: null,
      });
    });
  });

  describe('getLogs', () => {
    it('returns the newest entries first', () => {
      logAt(NOW - 2 * DAY, 'g1', 'oldest');
      logAt(NOW, 'g1', 'newest');
      logAt(NOW - DAY, 'g1', 'middle');

      expect(auditRepository.getLogs('g1').map((log) => log.details)).toEqual([
        'newest',
        'middle',
        'oldest',
      ]);
    });

    it("returns only the requested guild's entries", () => {
      logAt(NOW, 'g1', 'mine');
      logAt(NOW + 1, 'g2', 'theirs');

      expect(auditRepository.getLogs('g1').map((log) => log.details)).toEqual([
        'mine',
      ]);
      expect(auditRepository.getLogs('unknown')).toEqual([]);
    });

    it('caps the result at 50 entries by default', () => {
      for (let i = 0; i < 55; i++) logAt(NOW + i);

      const logs = auditRepository.getLogs('g1');

      expect(logs).toHaveLength(50);
      // The cap drops the oldest, not the newest.
      expect(logs[0].created_at).toBe(NOW + 54);
      expect(logs[49].created_at).toBe(NOW + 5);
    });

    it('honours an explicit limit', () => {
      for (let i = 0; i < 5; i++) logAt(NOW + i);

      expect(auditRepository.getLogs('g1', 2).map((l) => l.created_at)).toEqual(
        [NOW + 4, NOW + 3]
      );
    });

    it('skips `offset` entries, so every page is reachable', () => {
      for (let i = 0; i < 5; i++) logAt(NOW + i);

      expect(
        auditRepository.getLogs('g1', 2, 2).map((l) => l.created_at)
      ).toEqual([NOW + 2, NOW + 1]);
      expect(
        auditRepository.getLogs('g1', 2, 4).map((l) => l.created_at)
      ).toEqual([NOW]);
      expect(auditRepository.getLogs('g1', 2, 5)).toEqual([]);
    });

    it('treats a negative offset as the first page', () => {
      for (let i = 0; i < 3; i++) logAt(NOW + i);

      expect(
        auditRepository.getLogs('g1', 1, -10).map((l) => l.created_at)
      ).toEqual([NOW + 2]);
    });

    it('pages entries written in the same millisecond without repeats or gaps', () => {
      for (let i = 0; i < 5; i++) logAt(NOW, 'g1', `same ms #${i}`);

      const pages = [0, 2, 4].flatMap((offset) =>
        auditRepository.getLogs('g1', 2, offset).map((log) => log.details)
      );

      // Newest first by id among equal timestamps.
      expect(pages).toEqual([
        'same ms #4',
        'same ms #3',
        'same ms #2',
        'same ms #1',
        'same ms #0',
      ]);
    });
  });

  describe('getLogsCount', () => {
    it('counts entries per guild', () => {
      logAt(NOW, 'g1');
      logAt(NOW + 1, 'g1');
      logAt(NOW + 2, 'g2');

      expect(auditRepository.getLogsCount('g1')).toBe(2);
      expect(auditRepository.getLogsCount('g2')).toBe(1);
      expect(auditRepository.getLogsCount('unknown')).toBe(0);
    });
  });

  describe('deleteOldLogs', () => {
    it('deletes entries strictly older than the cutoff and reports how many', () => {
      const cutoff = NOW - 90 * DAY;
      logAt(cutoff - 1, 'g1', 'just past retention');
      logAt(cutoff, 'g1', 'exactly at the cutoff');
      logAt(cutoff + 1, 'g1', 'just inside retention');
      logAt(cutoff - DAY, 'g2', 'other guild, past retention');
      vi.setSystemTime(NOW);

      const deleted = auditRepository.deleteOldLogs(90);

      expect(deleted).toBe(2);
      expect(
        auditRepository
          .getLogs('g1')
          .map((log) => log.details)
          .sort()
      ).toEqual(['exactly at the cutoff', 'just inside retention']);
      expect(auditRepository.getLogsCount('g2')).toBe(0);
    });

    it('returns 0 and keeps everything when nothing is old enough', () => {
      logAt(NOW - DAY);
      logAt(NOW);
      vi.setSystemTime(NOW);

      expect(auditRepository.deleteOldLogs(90)).toBe(0);
      expect(auditRepository.getLogsCount('g1')).toBe(2);
    });

    it('treats a zero-day retention as "anything before now"', () => {
      logAt(NOW - 1, 'g1', 'a moment ago');
      logAt(NOW, 'g1', 'now');
      vi.setSystemTime(NOW);

      expect(auditRepository.deleteOldLogs(0)).toBe(1);
      expect(auditRepository.getLogs('g1').map((log) => log.details)).toEqual([
        'now',
      ]);
    });
  });

  describe('getAuditChannel', () => {
    it('is null for a guild that never configured one', () => {
      expect(auditRepository.getAuditChannel('g1')).toBeNull();
    });

    it('reads the channel stored in guild settings', () => {
      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');

      expect(auditRepository.getAuditChannel('g1')).toBe('audit-chan');
      expect(auditRepository.getAuditChannel('g2')).toBeNull();
    });

    it('is null again once the channel is cleared', () => {
      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');
      guildSettingsRepository.setAuditChannel('g1', null);

      expect(auditRepository.getAuditChannel('g1')).toBeNull();
    });

    it('is null for a guild whose settings row exists for other reasons', () => {
      guildSettingsRepository.setLanguage('g1', 'en');

      expect(auditRepository.getAuditChannel('g1')).toBeNull();
    });
  });
});
