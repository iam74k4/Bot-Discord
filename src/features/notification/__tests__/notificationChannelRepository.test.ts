import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  clearNotificationTables,
  migrateNotificationSchema,
} from './notification.helpers.js';

/**
 * One row per (guild, type) decides where VC and welcome notifications go.
 * The interesting parts are the upsert and the enabled flag, so these run
 * against real SQLite with the production migration.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { notificationChannelRepository } =
  await import('../repositories/notificationChannelRepository.js');

const T0 = new Date('2026-07-15T12:00:00Z').getTime();

describe('notificationChannelRepository', () => {
  beforeAll(async () => {
    await migrateNotificationSchema();
  });

  beforeEach(() => {
    clearNotificationTables(db);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    db.close();
  });

  describe('get', () => {
    it('returns null when the guild has never configured the type', () => {
      expect(notificationChannelRepository.get('guild-1', 'voice')).toBeNull();
    });

    it('returns the stored record with both timestamps set on insert', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');

      expect(notificationChannelRepository.get('guild-1', 'voice')).toEqual({
        guild_id: 'guild-1',
        type: 'voice',
        channel_id: 'chan-1',
        enabled: 1,
        created_at: T0,
        updated_at: T0,
      });
    });
  });

  describe('set', () => {
    it('moves an existing configuration instead of adding a second row', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');
      vi.setSystemTime(T0 + 5_000);

      notificationChannelRepository.set('guild-1', 'voice', 'chan-2');

      const rows = notificationChannelRepository.getAllForGuild('guild-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channel_id: 'chan-2',
        created_at: T0,
        updated_at: T0 + 5_000,
      });
    });

    it('re-enables a configuration that had been switched off', () => {
      notificationChannelRepository.set('guild-1', 'member_join', 'chan-1');
      db.prepare(
        "UPDATE notification_channels SET enabled = 0 WHERE type = 'member_join'"
      ).run();
      expect(
        notificationChannelRepository.getEnabled('guild-1', 'member_join')
      ).toBeNull();

      notificationChannelRepository.set('guild-1', 'member_join', 'chan-1');

      expect(
        notificationChannelRepository.getEnabled('guild-1', 'member_join')
      ).toBe('chan-1');
    });

    it('keeps voice and welcome channels independent within a guild', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'vc-log');
      notificationChannelRepository.set('guild-1', 'member_join', 'welcome');

      expect(notificationChannelRepository.getEnabled('guild-1', 'voice')).toBe(
        'vc-log'
      );
      expect(
        notificationChannelRepository.getEnabled('guild-1', 'member_join')
      ).toBe('welcome');
    });
  });

  describe('getEnabled', () => {
    it('returns null for a type that is not configured', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');

      expect(
        notificationChannelRepository.getEnabled('guild-1', 'member_join')
      ).toBeNull();
    });

    it('returns null for a disabled row even though a channel is stored', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');
      db.prepare('UPDATE notification_channels SET enabled = 0').run();

      expect(notificationChannelRepository.get('guild-1', 'voice')).not.toBe(
        null
      );
      expect(
        notificationChannelRepository.getEnabled('guild-1', 'voice')
      ).toBeNull();
    });

    it('does not leak another guild configuration', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');

      expect(
        notificationChannelRepository.getEnabled('guild-2', 'voice')
      ).toBeNull();
    });
  });

  describe('remove', () => {
    it('reports true and deletes only the requested type', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');
      notificationChannelRepository.set('guild-1', 'member_join', 'chan-2');

      expect(notificationChannelRepository.remove('guild-1', 'voice')).toBe(
        true
      );

      expect(notificationChannelRepository.get('guild-1', 'voice')).toBeNull();
      expect(
        notificationChannelRepository.getEnabled('guild-1', 'member_join')
      ).toBe('chan-2');
    });

    it('reports false when there was nothing to delete', () => {
      expect(notificationChannelRepository.remove('guild-1', 'voice')).toBe(
        false
      );
    });

    it('reports false the second time the same type is removed', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');

      notificationChannelRepository.remove('guild-1', 'voice');

      expect(notificationChannelRepository.remove('guild-1', 'voice')).toBe(
        false
      );
    });

    it('leaves the same type in another guild alone', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');
      notificationChannelRepository.set('guild-2', 'voice', 'chan-9');

      notificationChannelRepository.remove('guild-1', 'voice');

      expect(notificationChannelRepository.getEnabled('guild-2', 'voice')).toBe(
        'chan-9'
      );
    });
  });

  describe('getAllForGuild', () => {
    it('returns an empty list for an unconfigured guild', () => {
      expect(notificationChannelRepository.getAllForGuild('guild-1')).toEqual(
        []
      );
    });

    it('returns every type configured for that guild and nothing else', () => {
      notificationChannelRepository.set('guild-1', 'voice', 'chan-1');
      notificationChannelRepository.set('guild-1', 'member_join', 'chan-2');
      notificationChannelRepository.set('guild-2', 'voice', 'chan-3');

      const rows = notificationChannelRepository.getAllForGuild('guild-1');

      expect(rows.map((row) => [row.type, row.channel_id]).sort()).toEqual([
        ['member_join', 'chan-2'],
        ['voice', 'chan-1'],
      ]);
    });
  });
});
