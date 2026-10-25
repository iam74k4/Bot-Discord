import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  indexesOf,
  proxyDatabase,
  tableNames,
} from './infrastructure.helpers.js';

/**
 * 009 seeds the daily rollup from raw sessions exactly once. Getting this
 * wrong is silent: double-counting inflates everyone's stats on every boot,
 * and a wrong day bucket moves time between days.
 */
let db: DatabaseType = new Database(':memory:');

vi.mock('../connection.js', () => ({
  database: proxyDatabase(() => db),
}));

const { up: createVoiceSessions } =
  await import('../migrations/004_notification.js');
const { up: createDailyStats } =
  await import('../migrations/009_voice_daily_stats.js');

const NOW = new Date('2026-05-01T09:30:00Z').getTime();

interface SessionInput {
  guild?: string;
  user?: string;
  channel?: string;
  channelName?: string;
  joinedAt: string;
  durationMs: number | null;
}

function insertSession(session: SessionInput): void {
  const joinedAt = new Date(session.joinedAt).getTime();
  db.prepare(
    `INSERT INTO voice_sessions (guild_id, user_id, channel_id, channel_name, joined_at, left_at, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.guild ?? 'g1',
    session.user ?? 'u1',
    session.channel ?? 'vc1',
    session.channelName ?? 'General',
    joinedAt,
    session.durationMs === null ? null : joinedAt + session.durationMs,
    session.durationMs,
    joinedAt
  );
}

function dailyStats() {
  return db
    .prepare(
      'SELECT * FROM voice_daily_stats ORDER BY guild_id, user_id, channel_id, day'
    )
    .all();
}

describe('009_voice_daily_stats', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    createVoiceSessions();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('creates the rollup table and its lookup index on an empty database', () => {
    createDailyStats();

    expect(tableNames(db)).toContain('voice_daily_stats');
    expect(indexesOf(db, 'voice_daily_stats')).toEqual({
      idx_voice_daily_stats_lookup: ['guild_id', 'user_id', 'day'],
    });
    expect(dailyStats()).toEqual([]);
  });

  it('sums completed sessions per guild, user, channel, and UTC day', () => {
    insertSession({ joinedAt: '2026-04-20T10:00:00Z', durationMs: 60_000 });
    insertSession({ joinedAt: '2026-04-20T18:00:00Z', durationMs: 30_000 });
    insertSession({ joinedAt: '2026-04-21T10:00:00Z', durationMs: 5_000 });
    insertSession({
      user: 'u2',
      joinedAt: '2026-04-20T10:00:00Z',
      durationMs: 1_000,
    });
    insertSession({
      guild: 'g2',
      joinedAt: '2026-04-20T10:00:00Z',
      durationMs: 2_000,
    });

    createDailyStats();

    expect(dailyStats()).toEqual([
      {
        guild_id: 'g1',
        user_id: 'u1',
        channel_id: 'vc1',
        channel_name: 'General',
        day: '2026-04-20',
        total_duration_ms: 90_000,
        session_count: 2,
        updated_at: NOW,
      },
      {
        guild_id: 'g1',
        user_id: 'u1',
        channel_id: 'vc1',
        channel_name: 'General',
        day: '2026-04-21',
        total_duration_ms: 5_000,
        session_count: 1,
        updated_at: NOW,
      },
      expect.objectContaining({
        guild_id: 'g1',
        user_id: 'u2',
        day: '2026-04-20',
        total_duration_ms: 1_000,
        session_count: 1,
      }),
      expect.objectContaining({
        guild_id: 'g2',
        user_id: 'u1',
        day: '2026-04-20',
        total_duration_ms: 2_000,
        session_count: 1,
      }),
    ]);
  });

  it('buckets by the UTC day the session started in', () => {
    insertSession({ joinedAt: '2026-04-20T23:59:59.999Z', durationMs: 1_000 });
    insertSession({ joinedAt: '2026-04-21T00:00:00.000Z', durationMs: 2_000 });

    createDailyStats();

    expect(
      dailyStats().map((row) => {
        const { day, total_duration_ms } = row as {
          day: string;
          total_duration_ms: number;
        };
        return [day, total_duration_ms];
      })
    ).toEqual([
      ['2026-04-20', 1_000],
      ['2026-04-21', 2_000],
    ]);
  });

  it('keeps separate rows per channel and the alphabetically largest name per channel', () => {
    insertSession({
      channel: 'vc1',
      channelName: 'Zulu',
      joinedAt: '2026-04-20T10:00:00Z',
      durationMs: 1_000,
    });
    // Renamed later the same day. The backfill keeps MAX(channel_name), so
    // the older name wins here because it sorts after the newer one.
    insertSession({
      channel: 'vc1',
      channelName: 'Alpha',
      joinedAt: '2026-04-20T12:00:00Z',
      durationMs: 1_000,
    });
    insertSession({
      channel: 'vc2',
      channelName: 'Other',
      joinedAt: '2026-04-20T10:00:00Z',
      durationMs: 4_000,
    });

    createDailyStats();

    expect(dailyStats()).toEqual([
      expect.objectContaining({
        channel_id: 'vc1',
        channel_name: 'Zulu',
        total_duration_ms: 2_000,
        session_count: 2,
      }),
      expect.objectContaining({
        channel_id: 'vc2',
        channel_name: 'Other',
        total_duration_ms: 4_000,
        session_count: 1,
      }),
    ]);
  });

  it('ignores sessions that are still open or lasted no time', () => {
    insertSession({ joinedAt: '2026-04-20T10:00:00Z', durationMs: null });
    insertSession({ joinedAt: '2026-04-20T11:00:00Z', durationMs: 0 });
    insertSession({ joinedAt: '2026-04-20T12:00:00Z', durationMs: 1 });

    createDailyStats();

    expect(dailyStats()).toEqual([
      expect.objectContaining({ total_duration_ms: 1, session_count: 1 }),
    ]);
  });

  it('does not backfill again once the rollup has rows', () => {
    insertSession({ joinedAt: '2026-04-20T10:00:00Z', durationMs: 60_000 });
    createDailyStats();
    const afterFirstBoot = dailyStats();

    // Later sessions reach the rollup through endSession(), not the backfill.
    insertSession({ joinedAt: '2026-04-22T10:00:00Z', durationMs: 10_000 });
    vi.setSystemTime(NOW + 60_000);
    createDailyStats();

    expect(dailyStats()).toEqual(afterFirstBoot);
  });

  it('checks for an existing row instead of counting the whole rollup', () => {
    // This check runs on every boot. COUNT(*) reads every page of the table -
    // about 140 ms on a large database with a cold page cache - where EXISTS
    // stops at the first row.
    const prepare = vi.spyOn(db, 'prepare');

    createDailyStats();

    const reads = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /FROM\s+voice_daily_stats\b/i.test(sql));
    expect(reads).toEqual([
      expect.stringMatching(
        /^SELECT EXISTS \(SELECT 1 FROM voice_daily_stats\) AS populated$/
      ),
    ]);
  });

  it('backfills on a later boot if the rollup is still empty', () => {
    createDailyStats();
    insertSession({ joinedAt: '2026-04-20T10:00:00Z', durationMs: 60_000 });

    createDailyStats();

    expect(dailyStats()).toEqual([
      expect.objectContaining({ day: '2026-04-20', total_duration_ms: 60_000 }),
    ]);
  });
});
