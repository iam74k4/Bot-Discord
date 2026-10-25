import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auto-join policy decides whether the bot is allowed to keep a channel's
 * audio at all, so its defaults and its failure behaviour matter as much as
 * the happy path. Runs against real SQLite with the real migrations.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

const debug = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { voiceSettingsRepository: repo } =
  await import('../repositories/voiceSettingsRepository.js');
const { up: settingsTables } =
  await import('../../../infrastructure/database/migrations/003_settings.js');
const { up: voiceAutoJoinTables } =
  await import('../../../infrastructure/database/migrations/007_voice_autojoin.js');
const { up: announcementColumn } =
  await import('../../../infrastructure/database/migrations/008_announcement_channel.js');

const GUILD = 'guild-1';

describe('voiceSettingsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.exec(`
      DROP TABLE IF EXISTS voice_autojoin_exclusions;
      DROP TABLE IF EXISTS guild_settings;
      DROP TABLE IF EXISTS audit_logs;
    `);
    settingsTables();
    voiceAutoJoinTables();
    announcementColumn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('guild switch', () => {
    it('defaults to enabled for a guild that has never opted out', () => {
      expect(repo.isAutoJoinEnabled(GUILD)).toBe(true);
    });

    it('round-trips disable and re-enable', () => {
      repo.setAutoJoinEnabled(GUILD, false);
      expect(repo.isAutoJoinEnabled(GUILD)).toBe(false);

      repo.setAutoJoinEnabled(GUILD, true);
      expect(repo.isAutoJoinEnabled(GUILD)).toBe(true);
    });

    it('is scoped per guild', () => {
      repo.setAutoJoinEnabled(GUILD, false);

      expect(repo.isAutoJoinEnabled('guild-2')).toBe(true);
    });

    it('stores the switch in the shared guild_settings row', () => {
      repo.setAutoJoinEnabled(GUILD, false);

      const row = db
        .prepare(
          'SELECT voice_autojoin_enabled FROM guild_settings WHERE guild_id = ?'
        )
        .get(GUILD) as { voice_autojoin_enabled: number };
      expect(row.voice_autojoin_enabled).toBe(0);
    });
  });

  describe('channel exclusions', () => {
    it('reports a channel as excluded only after it is added', () => {
      expect(repo.isChannelExcluded(GUILD, 'voice-1')).toBe(false);

      repo.addExclusion(GUILD, 'voice-1');

      expect(repo.isChannelExcluded(GUILD, 'voice-1')).toBe(true);
      expect(repo.isChannelExcluded(GUILD, 'voice-2')).toBe(false);
    });

    it('keeps exclusions per guild even for the same channel id', () => {
      repo.addExclusion(GUILD, 'voice-1');

      expect(repo.isChannelExcluded('guild-2', 'voice-1')).toBe(false);
      expect(repo.listExclusions('guild-2')).toEqual([]);
    });

    it('ignores a duplicate add instead of throwing', () => {
      repo.addExclusion(GUILD, 'voice-1');

      expect(() => repo.addExclusion(GUILD, 'voice-1')).not.toThrow();
      expect(repo.listExclusions(GUILD)).toEqual(['voice-1']);
    });

    it('lists exclusions oldest first', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
      repo.addExclusion(GUILD, 'voice-c');
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      repo.addExclusion(GUILD, 'voice-a');
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      repo.addExclusion(GUILD, 'voice-b');

      expect(repo.listExclusions(GUILD)).toEqual([
        'voice-a',
        'voice-b',
        'voice-c',
      ]);
    });

    it('returns an empty list for a guild with no exclusions', () => {
      expect(repo.listExclusions(GUILD)).toEqual([]);
    });

    it('reports whether a removal actually deleted something', () => {
      repo.addExclusion(GUILD, 'voice-1');

      expect(repo.removeExclusion(GUILD, 'voice-1')).toBe(true);
      expect(repo.isChannelExcluded(GUILD, 'voice-1')).toBe(false);
      expect(repo.removeExclusion(GUILD, 'voice-1')).toBe(false);
    });

    it('does not remove the same channel id from another guild', () => {
      repo.addExclusion('guild-2', 'voice-1');

      expect(repo.removeExclusion(GUILD, 'voice-1')).toBe(false);
      expect(repo.isChannelExcluded('guild-2', 'voice-1')).toBe(true);
    });
  });

  describe('mayAutoJoin', () => {
    it('allows a channel in an enabled guild that is not excluded', () => {
      expect(repo.mayAutoJoin(GUILD, 'voice-1')).toBe(true);
    });

    it('refuses every channel once the guild is disabled', () => {
      repo.setAutoJoinEnabled(GUILD, false);

      expect(repo.mayAutoJoin(GUILD, 'voice-1')).toBe(false);
    });

    it('refuses an excluded channel but still allows the rest of the guild', () => {
      repo.addExclusion(GUILD, 'voice-1');

      expect(repo.mayAutoJoin(GUILD, 'voice-1')).toBe(false);
      expect(repo.mayAutoJoin(GUILD, 'voice-2')).toBe(true);
    });
  });

  describe('when the tables are unreadable', () => {
    it('treats a channel as not excluded and logs at debug', () => {
      db.exec('DROP TABLE voice_autojoin_exclusions');

      expect(repo.isChannelExcluded(GUILD, 'voice-1')).toBe(false);
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to read auto-join exclusions for ${GUILD}`
        )
      );
    });

    it('lists no exclusions and logs at debug', () => {
      db.exec('DROP TABLE voice_autojoin_exclusions');

      expect(repo.listExclusions(GUILD)).toEqual([]);
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining(
          `Failed to list auto-join exclusions for ${GUILD}`
        )
      );
    });

    it('keeps the guild switch at its pre-setting default (enabled)', () => {
      db.exec('DROP TABLE guild_settings');

      expect(repo.isAutoJoinEnabled(GUILD)).toBe(true);
    });

    it('surfaces write failures to the caller instead of pretending to save', () => {
      db.exec('DROP TABLE voice_autojoin_exclusions');

      expect(() => repo.addExclusion(GUILD, 'voice-1')).toThrow();
      expect(() => repo.removeExclusion(GUILD, 'voice-1')).toThrow();
    });
  });
});
