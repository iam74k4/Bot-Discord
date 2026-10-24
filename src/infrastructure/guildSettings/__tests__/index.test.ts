import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behaviour runs through real SQLite and the real migrations, so the tests
 * check what a guild's row ends up holding rather than the SQL text used to
 * get there. The connection is a set of stubs only so that the failure tests
 * can make the database throw.
 */
const { prepare, exec, pragma } = vi.hoisted(() => ({
  prepare: vi.fn(),
  exec: vi.fn(),
  pragma: vi.fn(),
}));

vi.mock('../../database/connection.js', () => ({
  database: { prepare, exec, pragma },
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

const { guildSettingsRepository } = await import('../index.js');
const migrations = await Promise.all([
  import('../../database/migrations/003_settings.js'),
  import('../../database/migrations/007_voice_autojoin.js'),
  import('../../database/migrations/008_announcement_channel.js'),
]);

const NOW = new Date('2026-08-01T00:00:00Z').getTime();
let db: DatabaseType;

/** Every query from here on fails the way a broken database would. */
function failDatabase(message: string): void {
  prepare.mockImplementation(() => {
    throw new Error(message);
  });
}

describe('guildSettingsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    prepare.mockImplementation((sql: string) => db.prepare(sql));
    exec.mockImplementation((sql: string) => db.exec(sql));
    pragma.mockImplementation((source: string) => db.pragma(source));
    for (const migration of migrations) migration.up();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe('defaults', () => {
    it('reports the documented defaults for a guild with no row', () => {
      expect(guildSettingsRepository.get('g1')).toBeNull();
      expect(guildSettingsRepository.getLanguage('g1')).toBeNull();
      expect(guildSettingsRepository.getAuditChannel('g1')).toBeNull();
      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBeNull();
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(true);
    });

    it('creates a row with defaults, not the column default language', () => {
      guildSettingsRepository.setAnnouncementChannel('g1', 'news');

      // The table's DEFAULT 'ja' must not apply: an unset language means
      // "follow each viewer", and inserting for another setting must not
      // pin the guild to Japanese.
      expect(guildSettingsRepository.get('g1')).toEqual({
        guild_id: 'g1',
        language: null,
        audit_channel_id: null,
        announcement_channel_id: 'news',
        voice_autojoin_enabled: 1,
        created_at: NOW,
        updated_at: NOW,
      });
    });

    it('keeps auto-join on and language unset when the first write is the audit channel', () => {
      guildSettingsRepository.setAuditChannel('g1', 'chan-1');

      expect(guildSettingsRepository.get('g1')).toEqual({
        guild_id: 'g1',
        language: null,
        audit_channel_id: 'chan-1',
        announcement_channel_id: null,
        voice_autojoin_enabled: 1,
        created_at: NOW,
        updated_at: NOW,
      });
    });

    it('creates an all-default row when an update names no fields', () => {
      guildSettingsRepository.update('g1', {});

      expect(guildSettingsRepository.get('g1')).toMatchObject({
        language: null,
        audit_channel_id: null,
        announcement_channel_id: null,
        voice_autojoin_enabled: 1,
      });
    });
  });

  describe('update', () => {
    it('keeps other fields and created_at on update, and bumps updated_at', () => {
      guildSettingsRepository.setLanguage('g1', 'en');
      vi.setSystemTime(NOW + 5_000);

      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');

      expect(guildSettingsRepository.get('g1')).toMatchObject({
        language: 'en',
        audit_channel_id: 'audit-chan',
        created_at: NOW,
        updated_at: NOW + 5_000,
      });
    });

    it('updates only the columns supplied', () => {
      guildSettingsRepository.update('g1', {
        language: 'ja',
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news',
        voice_autojoin_enabled: 0,
      });

      guildSettingsRepository.setLanguage('g1', 'en');

      expect(guildSettingsRepository.get('g1')).toMatchObject({
        language: 'en',
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news',
        voice_autojoin_enabled: 0,
      });
    });

    it('writes nothing when an update to an existing row supplies no columns', () => {
      guildSettingsRepository.setLanguage('g1', 'en');
      const before = guildSettingsRepository.get('g1');
      vi.setSystemTime(NOW + 5_000);

      expect(() => guildSettingsRepository.update('g1', {})).not.toThrow();
      // Explicit undefined is "leave it alone", not "clear it".
      guildSettingsRepository.update('g1', { language: undefined });

      expect(guildSettingsRepository.get('g1')).toEqual(before);
    });

    it('writes several fields in one update', () => {
      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');

      guildSettingsRepository.update('g1', {
        language: 'ja',
        announcement_channel_id: 'news',
        voice_autojoin_enabled: 0,
      });

      expect(guildSettingsRepository.get('g1')).toMatchObject({
        language: 'ja',
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news',
        voice_autojoin_enabled: 0,
      });
    });

    it('clears a setting when it is set to null', () => {
      guildSettingsRepository.setLanguage('g1', 'en');
      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');
      guildSettingsRepository.setAnnouncementChannel('g1', 'news');

      guildSettingsRepository.setLanguage('g1', null);
      guildSettingsRepository.setAuditChannel('g1', null);
      guildSettingsRepository.setAnnouncementChannel('g1', null);

      expect(guildSettingsRepository.getLanguage('g1')).toBeNull();
      expect(guildSettingsRepository.getAuditChannel('g1')).toBeNull();
      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBeNull();
    });

    it('stores the voice auto-join switch as 0/1 and round-trips it', () => {
      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', false);
      expect(guildSettingsRepository.get('g1')?.voice_autojoin_enabled).toBe(0);
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(false);

      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', true);
      expect(guildSettingsRepository.get('g1')?.voice_autojoin_enabled).toBe(1);
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(true);
    });

    it('keeps each guild separate', () => {
      guildSettingsRepository.setLanguage('g1', 'en');
      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', false);

      expect(guildSettingsRepository.getLanguage('g2')).toBeNull();
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g2')).toBe(true);
      expect(guildSettingsRepository.get('g2')).toBeNull();
    });
  });

  describe('reads', () => {
    it('returns each stored value through its getter', () => {
      guildSettingsRepository.update('g1', {
        language: 'en',
        audit_channel_id: 'audit-chan',
        announcement_channel_id: 'news',
      });

      expect(guildSettingsRepository.getLanguage('g1')).toBe('en');
      expect(guildSettingsRepository.getAuditChannel('g1')).toBe('audit-chan');
      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBe('news');
    });

    it('keeps the audit and announcement channels apart', () => {
      guildSettingsRepository.setAnnouncementChannel('g1', 'news');

      expect(guildSettingsRepository.getAuditChannel('g1')).toBeNull();

      guildSettingsRepository.setAuditChannel('g1', 'audit-chan');

      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBe('news');
    });
  });

  describe('when the database fails', () => {
    it('degrades to "follow the viewer" for the language', () => {
      failDatabase('no such table: guild_settings');

      expect(guildSettingsRepository.getLanguage('g1')).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('language for guild g1')
      );
    });

    it('keeps voice auto-join enabled', () => {
      failDatabase('database is locked');

      // Failing closed here would silently stop recording for every guild.
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(true);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('voice auto-join for guild g1')
      );
    });

    it('skips a guild whose announcement channel cannot be read', () => {
      failDatabase('database disk image is malformed');

      // A broadcast walks every guild; one bad row must not abort it.
      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('announcement channel for guild g1')
      );
    });

    it('lets the audit channel lookup throw so the audit service can log it', () => {
      failDatabase('database is locked');

      expect(() => guildSettingsRepository.getAuditChannel('g1')).toThrow(
        'database is locked'
      );
    });

    it('lets a failed write reach the caller', () => {
      failDatabase('attempt to write a readonly database');

      expect(() => guildSettingsRepository.setLanguage('g1', 'en')).toThrow(
        'attempt to write a readonly database'
      );
    });
  });
});
