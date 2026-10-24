import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  col,
  describeSchema,
  dumpRows,
  indexNames,
  proxyDatabase,
  tableNames,
  type TableShape,
} from './infrastructure.helpers.js';

/**
 * `initializeDatabase()` runs on every boot against whatever database the
 * deployment already has, so these tests drive the real migration files
 * against real SQLite: a fresh install, a reboot, and an upgrade from a
 * database that still carries the removed Steam feature's tables.
 */
let db: DatabaseType = new Database(':memory:');

vi.mock('../connection.js', () => ({
  database: proxyDatabase(() => db),
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

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations'
);

/** Migration files on disk, so adding one does not need a test edit here. */
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((file) => /^\d{3}_.*\.ts$/.test(file))
  .sort();

/** Load a fresh copy of the runner, with its once-per-process flag reset. */
async function loadRunner() {
  return import('../migrations/index.js');
}

/** Run individual migrations by file prefix, bypassing the runner. */
async function runMigrations(...prefixes: string[]): Promise<void> {
  for (const prefix of prefixes) {
    const file = MIGRATION_FILES.find((name) => name.startsWith(prefix));
    if (!file) throw new Error(`No migration with prefix ${prefix}`);
    // Same file-URL import the production runner uses, so a vi.doMock of a
    // migration applies here too.
    const mod = (await import(
      pathToFileURL(join(MIGRATIONS_DIR, file)).href
    )) as {
      up: () => void;
    };
    mod.up();
  }
}

/** The schema documented in docs/database.md, as SQLite reports it. */
const DOCUMENTED_SCHEMA: Record<string, TableShape> = {
  audit_logs: {
    columns: {
      id: col('INTEGER', { pk: 1 }),
      guild_id: col('TEXT', { notNull: true }),
      user_id: col('TEXT', { notNull: true }),
      action: col('TEXT', { notNull: true }),
      target_id: col('TEXT'),
      details: col('TEXT'),
      created_at: col('INTEGER', { notNull: true }),
    },
    indexes: {
      idx_audit_logs_created_at: ['created_at'],
      idx_audit_logs_guild_id: ['guild_id'],
    },
  },
  guild_settings: {
    columns: {
      guild_id: col('TEXT', { pk: 1 }),
      language: col('TEXT', { default: "'ja'" }),
      audit_channel_id: col('TEXT'),
      announcement_channel_id: col('TEXT'),
      voice_autojoin_enabled: col('INTEGER', { notNull: true, default: '1' }),
      created_at: col('INTEGER', { notNull: true }),
      updated_at: col('INTEGER', { notNull: true }),
    },
    indexes: {},
  },
  notification_channels: {
    columns: {
      guild_id: col('TEXT', { notNull: true, pk: 1 }),
      type: col('TEXT', { notNull: true, pk: 2 }),
      channel_id: col('TEXT', { notNull: true }),
      enabled: col('INTEGER', { notNull: true, default: '1' }),
      created_at: col('INTEGER', { notNull: true }),
      updated_at: col('INTEGER', { notNull: true }),
    },
    indexes: {},
  },
  polls: {
    columns: {
      message_id: col('TEXT', { pk: 1 }),
      guild_id: col('TEXT', { notNull: true }),
      channel_id: col('TEXT', { notNull: true }),
      creator_id: col('TEXT', { notNull: true }),
      expires_at: col('INTEGER', { notNull: true }),
      created_at: col('INTEGER', { notNull: true }),
    },
    indexes: {
      idx_polls_creator: ['creator_id', 'channel_id'],
    },
  },
  voice_autojoin_exclusions: {
    columns: {
      guild_id: col('TEXT', { notNull: true, pk: 1 }),
      channel_id: col('TEXT', { notNull: true, pk: 2 }),
      created_at: col('INTEGER', { notNull: true }),
    },
    indexes: {},
  },
  voice_daily_stats: {
    columns: {
      guild_id: col('TEXT', { notNull: true, pk: 1 }),
      user_id: col('TEXT', { notNull: true, pk: 2 }),
      channel_id: col('TEXT', { notNull: true, pk: 3 }),
      channel_name: col('TEXT', { notNull: true }),
      day: col('TEXT', { notNull: true, pk: 4 }),
      total_duration_ms: col('INTEGER', { notNull: true }),
      session_count: col('INTEGER', { notNull: true }),
      updated_at: col('INTEGER', { notNull: true }),
    },
    indexes: {
      idx_voice_daily_stats_lookup: ['guild_id', 'user_id', 'day'],
    },
  },
  voice_sessions: {
    columns: {
      id: col('INTEGER', { pk: 1 }),
      guild_id: col('TEXT', { notNull: true }),
      user_id: col('TEXT', { notNull: true }),
      channel_id: col('TEXT', { notNull: true }),
      channel_name: col('TEXT', { notNull: true }),
      joined_at: col('INTEGER', { notNull: true }),
      left_at: col('INTEGER'),
      duration_ms: col('INTEGER'),
      created_at: col('INTEGER', { notNull: true }),
    },
    indexes: {
      idx_voice_sessions_guild_channel: ['guild_id', 'channel_id'],
      idx_voice_sessions_guild_user: ['guild_id', 'user_id'],
      idx_voice_sessions_joined_at: ['joined_at'],
    },
  },
};

const LEGACY_STEAM_TABLES = [
  'game_activity_cache',
  'notification_settings',
  'playtime_history',
  'steam_users',
  'user_notification_prefs',
];

const NOW = new Date('2026-03-15T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

/** One row in every table the bot keeps, for "nothing was lost" checks. */
function seedKeptTables(): void {
  db.prepare(
    `INSERT INTO guild_settings (guild_id, language, audit_channel_id, announcement_channel_id, voice_autojoin_enabled, created_at, updated_at)
     VALUES ('g1', 'en', 'audit-chan', 'news-chan', 0, 1, 2)`
  ).run();
  db.prepare(
    `INSERT INTO audit_logs (guild_id, user_id, action, target_id, details, created_at)
     VALUES ('g1', 'u1', 'ROLE_ADD', 't1', 'Role: Member', 3)`
  ).run();
  db.prepare(
    `INSERT INTO notification_channels (guild_id, type, channel_id, enabled, created_at, updated_at)
     VALUES ('g1', 'voice', 'vc-log', 1, 4, 5)`
  ).run();
  db.prepare(
    `INSERT INTO voice_sessions (guild_id, user_id, channel_id, channel_name, joined_at, left_at, duration_ms, created_at)
     VALUES ('g1', 'u1', 'vc1', 'General', ?, ?, 60000, ?)`
  ).run(NOW - DAY, NOW - DAY + 60000, NOW - DAY);
  db.prepare(
    `INSERT INTO voice_daily_stats (guild_id, user_id, channel_id, channel_name, day, total_duration_ms, session_count, updated_at)
     VALUES ('g1', 'u1', 'vc1', 'General', '2026-03-14', 60000, 1, 6)`
  ).run();
  db.prepare(
    `INSERT INTO polls (message_id, guild_id, channel_id, creator_id, expires_at, created_at)
     VALUES ('m1', 'g1', 'c1', 'u1', ?, 7)`
  ).run(NOW + DAY);
  db.prepare(
    `INSERT INTO voice_autojoin_exclusions (guild_id, channel_id, created_at)
     VALUES ('g1', 'vc-private', 8)`
  ).run();
}

describe('initializeDatabase', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.doUnmock('fs');
    vi.doUnmock('../migrations/005_drop_steam.js');
    vi.doUnmock('../migrations/006_polls.js');
    vi.doUnmock('../migrations/008_announcement_channel.js');
    vi.doUnmock('../migrations/010_native_polls.js');
    vi.useRealTimers();
    db.close();
  });

  describe('fresh database', () => {
    it('creates exactly the documented tables, columns, and indexes', async () => {
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(describeSchema(db)).toEqual(DOCUMENTED_SCHEMA);
    });

    it('leaves no trace of superseded tables or indexes', async () => {
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      const tables = tableNames(db);
      for (const legacy of [...LEGACY_STEAM_TABLES, 'poll_votes']) {
        expect(tables).not.toContain(legacy);
      }
      // 006's poll indexes went with the table 010 dropped.
      expect(indexNames(db)).not.toContain('idx_polls_guild_id');
      expect(indexNames(db)).not.toContain('idx_polls_ends_at');
      expect(indexNames(db)).not.toContain('idx_playtime_history_discord_id');
    });

    it('reports how many migrations it applied', async () => {
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(logger.info).toHaveBeenCalledWith(
        `Database initialized (${MIGRATION_FILES.length} migrations)`
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('applies a row default for voice auto-join and leaves the poll table empty', async () => {
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();
      db.prepare(
        `INSERT INTO guild_settings (guild_id, created_at, updated_at) VALUES ('g1', 1, 1)`
      ).run();

      expect(
        db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get('g1')
      ).toMatchObject({
        language: 'ja',
        audit_channel_id: null,
        announcement_channel_id: null,
        voice_autojoin_enabled: 1,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM polls').get()).toEqual({
        n: 0,
      });
    });
  });

  describe('ordering', () => {
    it('applies migrations by numeric prefix whatever order the directory lists them in', async () => {
      const actualFs = await vi.importActual<typeof import('fs')>('fs');
      vi.doMock('fs', () => ({
        ...actualFs,
        // Reverse order would run 007's ALTER before 003 creates the table.
        // Non-migration files must be skipped, including type declarations.
        readdirSync: (dir: string) => [
          'index.ts',
          'README.md',
          '011_future.d.ts',
          ...actualFs.readdirSync(dir).reverse(),
        ],
      }));
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(describeSchema(db)).toEqual(DOCUMENTED_SCHEMA);
      expect(logger.info).toHaveBeenCalledWith(
        `Database initialized (${MIGRATION_FILES.length} migrations)`
      );
    });

    it('warns about and skips a migration that exports no up function', async () => {
      // Vitest's module mock rejects reads of undeclared exports, so the
      // missing export is declared as undefined - what a real module yields.
      vi.doMock('../migrations/006_polls.js', () => ({ up: undefined }));
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(logger.warn).toHaveBeenCalledWith(
        'Migration 006_polls.ts does not export an `up` function'
      );
      expect(logger.info).toHaveBeenCalledWith(
        `Database initialized (${MIGRATION_FILES.length - 1} migrations)`
      );
      // 006 is superseded by 010, so the end state is unaffected.
      expect(describeSchema(db)).toEqual(DOCUMENTED_SCHEMA);
    });
  });

  describe('idempotency', () => {
    it('skips a second call in the same process and keeps the data', async () => {
      const { initializeDatabase } = await loadRunner();
      await initializeDatabase();
      seedKeptTables();
      const before = dumpRows(db);

      await initializeDatabase();

      expect(logger.warn).toHaveBeenCalledWith(
        'Database already initialized, skipping'
      );
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(dumpRows(db)).toEqual(before);
    });

    it('re-runs the guarded migrations on the next boot without changing schema or rows', async () => {
      const { initializeDatabase } = await loadRunner();
      await initializeDatabase();
      seedKeptTables();
      const schemaBefore = describeSchema(db);
      const rowsBefore = dumpRows(db);

      // Everything a reboot replays except 006 (see the known bug below):
      // 001/002 recreate the Steam tables and 005 drops them again, the
      // guarded ALTERs in 007/008 must not reset settings, 009 must not
      // backfill a second time, and 010 must keep live polls.
      await runMigrations(
        '001',
        '002',
        '003',
        '004',
        '005',
        '007',
        '008',
        '009',
        '010'
      );

      expect(describeSchema(db)).toEqual(schemaBefore);
      expect(dumpRows(db)).toEqual(rowsBefore);
    });

    /**
     * KNOWN BUG (reported, production code untouched): on every boot after the
     * first, 006_polls.ts runs `CREATE INDEX IF NOT EXISTS idx_polls_ends_at
     * ON polls(ends_at)` against the table 010 rebuilt without `ends_at`, so
     * initializeDatabase() throws "no such column: ends_at" and the bot cannot
     * restart. Drop `.fails` once 006 is guarded on the old schema.
     */
    it.fails(
      'boots a second time on an initialized database without changing schema or rows',
      async () => {
        const first = await loadRunner();
        await first.initializeDatabase();
        seedKeptTables();
        const schemaBefore = describeSchema(db);
        const rowsBefore = dumpRows(db);

        // A new process: the once-per-process flag starts false again.
        vi.resetModules();
        const second = await loadRunner();
        await second.initializeDatabase();

        expect(logger.warn).not.toHaveBeenCalled();
        expect(describeSchema(db)).toEqual(schemaBefore);
        expect(dumpRows(db)).toEqual(rowsBefore);
      }
    );

    it('keeps every row when a second boot fails part-way', async () => {
      const first = await loadRunner();
      await first.initializeDatabase();
      seedKeptTables();
      const schemaBefore = describeSchema(db);
      const rowsBefore = dumpRows(db);

      // Fail the reboot on purpose, early enough that it does not depend on
      // the 006 bug above: by the time 005 runs, 001/002 have recreated the
      // five Steam tables. The stand-in also destroys data before throwing,
      // as a half-applied migration would.
      vi.doMock('../migrations/005_drop_steam.js', () => ({
        up: () => {
          db.exec('DELETE FROM guild_settings');
          db.exec('DELETE FROM audit_logs');
          throw new Error('SQLITE_BUSY: database is locked');
        },
      }));
      vi.resetModules();
      const second = await loadRunner();

      await expect(second.initializeDatabase()).rejects.toThrow(
        'SQLITE_BUSY: database is locked'
      );

      // One transaction: the recreated Steam tables and the deletes are gone.
      expect(describeSchema(db)).toEqual(schemaBefore);
      expect(dumpRows(db)).toEqual(rowsBefore);
      expect(db.inTransaction).toBe(false);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('upgrade from a legacy database', () => {
    /**
     * A deployment from before 005: the Steam tables hold data, guild_settings
     * predates the 007/008 columns, and polls still use 006's custom schema.
     */
    async function buildLegacyDatabase(): Promise<void> {
      await runMigrations('001', '002', '003', '004', '006');

      db.prepare(
        `INSERT INTO steam_users (discord_id, steam_id, steam_name, registered_at) VALUES ('u1', 's1', 'gamer', 1)`
      ).run();
      db.prepare(
        `INSERT INTO playtime_history (discord_id, steam_id, total_playtime, recorded_at) VALUES ('u1', 's1', 120, 2)`
      ).run();
      db.prepare(
        `INSERT INTO notification_settings (guild_id, channel_id, enabled, created_at) VALUES ('g1', 'c1', 1, 3)`
      ).run();
      db.prepare(
        `INSERT INTO user_notification_prefs (discord_id, notify_enabled) VALUES ('u1', 0)`
      ).run();
      db.prepare(
        `INSERT INTO game_activity_cache (discord_id, current_game, game_started_at, last_checked) VALUES ('u1', 'Game', 4, 5)`
      ).run();

      db.prepare(
        `INSERT INTO guild_settings (guild_id, language, audit_channel_id, created_at, updated_at) VALUES ('g1', 'en', 'audit-chan', 10, 11)`
      ).run();
      db.prepare(
        `INSERT INTO audit_logs (guild_id, user_id, action, target_id, details, created_at) VALUES ('g1', 'u1', 'SETTINGS_CHANGE', NULL, 'Language: en', 12)`
      ).run();
      db.prepare(
        `INSERT INTO notification_channels (guild_id, type, channel_id, enabled, created_at, updated_at) VALUES ('g1', 'voice', 'vc-log', 0, 13, 14)`
      ).run();

      const insertSession = db.prepare(
        `INSERT INTO voice_sessions (guild_id, user_id, channel_id, channel_name, joined_at, left_at, duration_ms, created_at)
         VALUES ('g1', 'u1', 'vc1', 'General', ?, ?, ?, ?)`
      );
      const joined = new Date('2026-03-10T08:00:00Z').getTime();
      insertSession.run(joined, joined + 90000, 90000, joined);
      // Still open when the old version stopped: no duration yet.
      insertSession.run(joined + DAY, null, null, joined + DAY);

      db.prepare(
        `INSERT INTO polls (message_id, guild_id, channel_id, creator_id, question, options, anonymous, ends_at, locale, created_at)
         VALUES ('old-poll', 'g1', 'c1', 'u1', 'Lunch?', '["a","b"]', 0, NULL, 'ja', 15)`
      ).run();
      db.prepare(
        `INSERT INTO poll_votes (message_id, user_id, option_index, voted_at) VALUES ('old-poll', 'u2', 1, 16)`
      ).run();
    }

    it('drops every legacy Steam table', async () => {
      await buildLegacyDatabase();
      expect(tableNames(db)).toEqual(
        expect.arrayContaining(LEGACY_STEAM_TABLES)
      );
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      const tables = tableNames(db);
      for (const legacy of LEGACY_STEAM_TABLES) {
        expect(tables).not.toContain(legacy);
      }
      expect(indexNames(db)).not.toContain('idx_playtime_history_discord_id');
      expect(indexNames(db)).not.toContain('idx_playtime_history_recorded_at');
    });

    it('converges on the same schema as a fresh install', async () => {
      await buildLegacyDatabase();
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(describeSchema(db)).toEqual(DOCUMENTED_SCHEMA);
    });

    it('preserves rows in the tables it keeps', async () => {
      await buildLegacyDatabase();
      const keptBefore = {
        audit_logs: db.prepare('SELECT * FROM audit_logs').all(),
        notification_channels: db
          .prepare('SELECT * FROM notification_channels')
          .all(),
        voice_sessions: db
          .prepare('SELECT * FROM voice_sessions ORDER BY id')
          .all(),
      };
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(db.prepare('SELECT * FROM audit_logs').all()).toEqual(
        keptBefore.audit_logs
      );
      expect(db.prepare('SELECT * FROM notification_channels').all()).toEqual(
        keptBefore.notification_channels
      );
      expect(
        db.prepare('SELECT * FROM voice_sessions ORDER BY id').all()
      ).toEqual(keptBefore.voice_sessions);
    });

    it('gives existing guild settings the defaults of the columns added later', async () => {
      await buildLegacyDatabase();
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(
        db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get('g1')
      ).toEqual({
        guild_id: 'g1',
        language: 'en',
        audit_channel_id: 'audit-chan',
        created_at: 10,
        updated_at: 11,
        // 007: a guild that never chose keeps the pre-existing behaviour.
        voice_autojoin_enabled: 1,
        // 008: not opted in to announcements until it says so.
        announcement_channel_id: null,
      });
    });

    it('backfills daily voice stats from completed sessions only', async () => {
      await buildLegacyDatabase();
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(db.prepare('SELECT * FROM voice_daily_stats').all()).toEqual([
        {
          guild_id: 'g1',
          user_id: 'u1',
          channel_id: 'vc1',
          channel_name: 'General',
          day: '2026-03-10',
          total_duration_ms: 90000,
          session_count: 1,
          updated_at: NOW,
        },
      ]);
    });

    it('replaces the custom poll schema and its votes', async () => {
      await buildLegacyDatabase();
      const { initializeDatabase } = await loadRunner();

      await initializeDatabase();

      expect(tableNames(db)).not.toContain('poll_votes');
      expect(db.prepare('SELECT COUNT(*) AS n FROM polls').get()).toEqual({
        n: 0,
      });
    });
  });

  describe('failure', () => {
    it('rolls back every migration when one throws, then succeeds on retry', async () => {
      const failure = { active: true };
      const real = (await vi.importActual(
        '../migrations/008_announcement_channel.js'
      )) as { up: () => void };
      vi.doMock('../migrations/008_announcement_channel.js', () => ({
        up: () => {
          if (failure.active) throw new Error('disk I/O error');
          real.up();
        },
      }));
      const { initializeDatabase } = await loadRunner();

      await expect(initializeDatabase()).rejects.toThrow('disk I/O error');

      // 001-007 ran before the failure; one transaction means none of it stuck.
      expect(tableNames(db)).toEqual([]);
      expect(logger.info).not.toHaveBeenCalled();
      expect(db.inTransaction).toBe(false);

      // A failed run must not be remembered as done.
      failure.active = false;
      await initializeDatabase();

      expect(logger.warn).not.toHaveBeenCalledWith(
        'Database already initialized, skipping'
      );
      expect(describeSchema(db)).toEqual(DOCUMENTED_SCHEMA);
    });

    it('leaves a legacy database untouched when the upgrade fails', async () => {
      await runMigrations('001', '002', '003', '004');
      db.prepare(
        `INSERT INTO steam_users (discord_id, steam_id, steam_name, registered_at) VALUES ('u1', 's1', 'gamer', 1)`
      ).run();
      const schemaBefore = describeSchema(db);
      const rowsBefore = dumpRows(db);
      vi.doMock('../migrations/010_native_polls.js', () => ({
        up: () => {
          throw new Error('SQLITE_FULL');
        },
      }));
      const { initializeDatabase } = await loadRunner();

      await expect(initializeDatabase()).rejects.toThrow('SQLITE_FULL');

      // 005 had already dropped steam_users inside the transaction.
      expect(describeSchema(db)).toEqual(schemaBefore);
      expect(dumpRows(db)).toEqual(rowsBefore);
    });
  });
});
