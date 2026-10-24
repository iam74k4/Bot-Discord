import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

interface Statement {
  sql: string;
  get: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

let statements: Statement[];

/** Make every prepare() return a stub, with SELECT answering `row`. */
function stubDatabase(row: Record<string, unknown> | undefined) {
  statements = [];
  prepare.mockImplementation((sql: string) => {
    const statement: Statement = {
      sql,
      get: vi.fn().mockReturnValue(row),
      run: vi.fn(),
    };
    statements.push(statement);
    return statement;
  });
}

function writeStatement() {
  return statements.find(
    (s) => s.sql.includes('UPDATE') || s.sql.includes('INSERT')
  );
}

const existingRow = {
  guild_id: 'g1',
  language: 'ja',
  audit_channel_id: 'chan-1',
  voice_autojoin_enabled: 1,
  created_at: 1,
  updated_at: 1,
};

describe('guildSettingsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('update', () => {
    it('inserts a new row with defaults for fields the caller omitted', () => {
      stubDatabase(undefined);

      guildSettingsRepository.setAuditChannel('g1', 'chan-1');

      const insert = writeStatement();
      expect(insert?.sql).toContain('INSERT INTO guild_settings');
      // Auto-join defaults to on, and language stays NULL so configuring an
      // audit channel never pins the guild to a language it did not choose.
      expect(insert?.run).toHaveBeenCalledWith(
        'g1',
        null, // language
        'chan-1', // audit_channel_id
        null, // announcement_channel_id
        1, // voice_autojoin_enabled
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('updates only the columns supplied', () => {
      stubDatabase(existingRow);

      guildSettingsRepository.setLanguage('g1', 'en');

      const update = writeStatement();
      expect(update?.sql).toContain('UPDATE guild_settings SET language = ?');
      expect(update?.sql).not.toContain('audit_channel_id');
      expect(update?.run).toHaveBeenCalledWith('en', expect.any(Number), 'g1');
    });

    it('writes nothing when an update supplies no columns', () => {
      stubDatabase(existingRow);

      guildSettingsRepository.update('g1', {});

      expect(writeStatement()).toBeUndefined();
    });

    it('stores the voice auto-join flag as an integer', () => {
      stubDatabase(existingRow);

      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', false);

      expect(writeStatement()?.run).toHaveBeenCalledWith(
        0,
        expect.any(Number),
        'g1'
      );
    });
  });

  describe('reads', () => {
    it('returns the stored language', () => {
      stubDatabase(existingRow);
      expect(guildSettingsRepository.getLanguage('g1')).toBe('ja');
    });

    it('treats a missing row as "follow the viewer"', () => {
      stubDatabase(undefined);
      expect(guildSettingsRepository.getLanguage('g1')).toBeNull();
    });

    it('degrades to "follow the viewer" when the database fails', () => {
      prepare.mockImplementation(() => {
        throw new Error('no such table: guild_settings');
      });
      expect(guildSettingsRepository.getLanguage('g1')).toBeNull();
    });

    it('defaults voice auto-join to enabled for an unconfigured guild', () => {
      stubDatabase(undefined);
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(true);
    });

    it('keeps voice auto-join enabled when the database fails', () => {
      prepare.mockImplementation(() => {
        throw new Error('database is locked');
      });
      // Failing closed here would silently stop recording for every guild.
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(true);
    });

    it('reports the opt-out once it is stored', () => {
      stubDatabase({ ...existingRow, voice_autojoin_enabled: 0 });
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(false);
    });

    it('skips a guild whose announcement channel cannot be read', () => {
      prepare.mockImplementation(() => {
        throw new Error('database disk image is malformed');
      });
      // A broadcast walks every guild; one bad row must not abort it.
      expect(guildSettingsRepository.getAnnouncementChannel('g1')).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('announcement channel for guild g1')
      );
    });
  });

  /**
   * The stubs above pin the SQL each call issues; these run the same calls
   * through real SQLite and the real migrations, so they check what a guild's
   * row actually ends up holding.
   */
  describe('against SQLite', () => {
    const NOW = new Date('2026-08-01T00:00:00Z').getTime();
    let db: DatabaseType;

    beforeEach(async () => {
      db = new Database(':memory:');
      prepare.mockImplementation((sql: string) => db.prepare(sql));
      exec.mockImplementation((sql: string) => db.exec(sql));
      pragma.mockImplementation((source: string) => db.pragma(source));
      for (const migration of await Promise.all([
        import('../../database/migrations/003_settings.js'),
        import('../../database/migrations/007_voice_autojoin.js'),
        import('../../database/migrations/008_announcement_channel.js'),
      ])) {
        migration.up();
      }
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
      db.close();
    });

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

    it('creates an all-default row when an update names no fields', () => {
      guildSettingsRepository.update('g1', {});

      expect(guildSettingsRepository.get('g1')).toMatchObject({
        language: null,
        audit_channel_id: null,
        announcement_channel_id: null,
        voice_autojoin_enabled: 1,
      });
    });

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

    it('round-trips the voice auto-join switch', () => {
      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', false);
      expect(guildSettingsRepository.isVoiceAutoJoinEnabled('g1')).toBe(false);

      guildSettingsRepository.setVoiceAutoJoinEnabled('g1', true);
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
});
