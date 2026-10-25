import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * The rollup is the reason `/notification stats` can still answer "all time"
 * after the cleanup job has deleted the sessions it used to sum. That claim is
 * only true if the write path and the retention path agree, so these run
 * against a real SQLite database rather than a mocked statement recorder.
 */
const db = new Database(':memory:');

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
}));

vi.mock('../../../infrastructure/database/transaction.js', () => ({
  runTransaction: <T>(fn: () => T): T => db.transaction(fn)(),
}));

const { voiceSessionRepository, dayKey } =
  await import('../repositories/voiceSessionRepository.js');
const { setStatsTimeZone, DEFAULT_STATS_TIME_ZONE } =
  await import('../stats/calendar.js');
const { up: createVoiceSessions } =
  await import('../../../infrastructure/database/migrations/004_notification.js');
const { up: createDailyStats } =
  await import('../../../infrastructure/database/migrations/009_voice_daily_stats.js');

const GUILD = 'guild-1';
const USER = 'user-1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Noon in Japan, the stats zone: tests that expect several visits in one
// daily row must not straddle midnight, which an unpinned fake clock would do
// near 23:59. Pinned in UTC so the process time zone does not matter.
const NOON = new Date(Date.UTC(2026, 6, 15, 3, 0, 0));
// 00:00 on 2026-07-15 in Japan.
const JST_MIDNIGHT = Date.UTC(2026, 6, 14, 15, 0, 0);

function closedSession(
  channelId: string,
  joinedAt: number,
  durationMs: number
) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO voice_sessions
           (guild_id, user_id, channel_id, channel_name, joined_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(GUILD, USER, channelId, `#${channelId}`, joinedAt, joinedAt)
      .lastInsertRowid
  );
  db.prepare(
    'UPDATE voice_sessions SET left_at = ?, duration_ms = ? WHERE id = ?'
  ).run(joinedAt + durationMs, durationMs, id);
  return id;
}

/** A real visit: the clock has to move, or the session lasts zero ms. */
function recordSession(channelId: string, durationMs: number): number {
  const id = voiceSessionRepository.startSession(
    GUILD,
    USER,
    channelId,
    `#${channelId}`
  );
  vi.advanceTimersByTime(durationMs);
  voiceSessionRepository.endSession(id);
  return id;
}

function rollupRows() {
  return db
    .prepare(
      'SELECT channel_id, day, total_duration_ms, session_count FROM voice_daily_stats ORDER BY day, channel_id'
    )
    .all();
}

describe('voice daily stats rollup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    setStatsTimeZone(DEFAULT_STATS_TIME_ZONE);
    db.exec('DROP TABLE IF EXISTS voice_sessions');
    db.exec('DROP TABLE IF EXISTS notification_channels');
    db.exec('DROP TABLE IF EXISTS voice_daily_stats');
    createVoiceSessions();
    createDailyStats();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    db.close();
  });

  it('accumulates repeated sessions into one row per channel and day', () => {
    recordSession('vc-a', 60_000);
    recordSession('vc-a', 30_000);

    const rows = rollupRows() as Array<{
      channel_id: string;
      session_count: number;
      total_duration_ms: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_id).toBe('vc-a');
    expect(rows[0].session_count).toBe(2);
    expect(rows[0].total_duration_ms).toBe(90_000);
  });

  it('does not count a session twice when it is ended again', () => {
    const id = recordSession('vc-a', 60_000);
    const afterFirst = voiceSessionRepository.getUserTotalDuration(GUILD, USER);

    voiceSessionRepository.endSession(id);

    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      afterFirst
    );
    expect(rollupRows()).toHaveLength(1);
  });

  it('adds nothing for a stale session closed with zero duration', () => {
    voiceSessionRepository.startSession(GUILD, USER, 'vc-a', '#vc-a');
    voiceSessionRepository.closeAllStaleSessions();

    expect(rollupRows()).toHaveLength(0);
    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(0);
  });

  it('keeps totals after retention deletes the raw sessions', () => {
    recordSession('vc-a', 60_000);
    const before = voiceSessionRepository.getUserTotalDuration(GUILD, USER);

    // Everything closed is now older than a zero-day retention window.
    vi.advanceTimersByTime(1_000);
    voiceSessionRepository.cleanupOldSessions(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM voice_sessions').get() as {
          c: number;
        }
      ).c
    ).toBe(0);

    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      before
    );
  });

  it('splits history by day and honours a since cutoff', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    closedSession('vc-a', now - 3 * dayMs, 60_000);
    closedSession('vc-a', now, 30_000);
    // Backfill is what a database upgraded mid-life goes through.
    createDailyStats();

    const rows = rollupRows();
    expect(rows).toHaveLength(2);

    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      90_000
    );
    expect(
      voiceSessionRepository.getUserTotalDuration(
        GUILD,
        USER,
        dayKey(now - dayMs)
      )
    ).toBe(30_000);
  });

  it('backfills only once, however many boots run the migration', () => {
    closedSession('vc-a', Date.now(), 60_000);

    createDailyStats();
    createDailyStats();
    createDailyStats();

    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      60_000
    );
  });

  it('reports per-channel totals from the rollup', () => {
    recordSession('vc-a', 60_000);
    recordSession('vc-b', 30_000);

    const stats = voiceSessionRepository.getUserChannelStats(GUILD, USER);
    expect(stats.map((s) => s.channel_id).sort()).toEqual(['vc-a', 'vc-b']);
  });

  it('records an open session and hands back its id', () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
    const first = voiceSessionRepository.startSession(
      GUILD,
      USER,
      'vc-a',
      '#vc-a'
    );
    const second = voiceSessionRepository.startSession(
      GUILD,
      'user-2',
      'vc-a',
      '#vc-a'
    );

    expect(second).toBeGreaterThan(first);
    expect(
      db.prepare('SELECT * FROM voice_sessions WHERE id = ?').get(first)
    ).toMatchObject({
      guild_id: GUILD,
      user_id: USER,
      channel_id: 'vc-a',
      channel_name: '#vc-a',
      joined_at: Date.now(),
      left_at: null,
      duration_ms: null,
    });
  });

  it('closes a zero-length visit without adding it to the rollup', () => {
    const id = voiceSessionRepository.startSession(GUILD, USER, 'vc-a', '#a');

    // Same instant: the user bounced straight back out.
    voiceSessionRepository.endSession(id);

    expect(
      db.prepare('SELECT left_at, duration_ms FROM voice_sessions').get()
    ).toEqual({ left_at: Date.now(), duration_ms: 0 });
    expect(rollupRows()).toHaveLength(0);
  });

  it('keeps the latest channel name when a channel is renamed mid-day', () => {
    const first = voiceSessionRepository.startSession(
      GUILD,
      USER,
      'vc-a',
      'Old name'
    );
    vi.advanceTimersByTime(60_000);
    voiceSessionRepository.endSession(first);
    const second = voiceSessionRepository.startSession(
      GUILD,
      USER,
      'vc-a',
      'New name'
    );
    vi.advanceTimersByTime(60_000);
    voiceSessionRepository.endSession(second);

    expect(voiceSessionRepository.getUserChannelStats(GUILD, USER)).toEqual([
      {
        channel_id: 'vc-a',
        channel_name: 'New name',
        total_duration_ms: 120_000,
        session_count: 2,
      },
    ]);
  });

  describe('a channel renamed on a later day', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date(NOON.getTime() - DAY));
      const before = voiceSessionRepository.startSession(
        GUILD,
        USER,
        'vc-a',
        'Old name'
      );
      vi.advanceTimersByTime(MINUTE);
      voiceSessionRepository.endSession(before);

      vi.setSystemTime(NOON);
      const after = voiceSessionRepository.startSession(
        GUILD,
        USER,
        'vc-a',
        'New name'
      );
      vi.advanceTimersByTime(MINUTE);
      voiceSessionRepository.endSession(after);
    });

    it('still adds both days up under one channel', () => {
      const stats = voiceSessionRepository.getUserChannelStats(GUILD, USER);

      expect(rollupRows()).toHaveLength(2);
      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({
        channel_id: 'vc-a',
        total_duration_ms: 2 * MINUTE,
        session_count: 2,
      });
      expect(['Old name', 'New name']).toContain(stats[0].channel_name);
    });

    // Regression: the query selected a bare `channel_name` under `GROUP BY
    // channel_id`, and SQLite handed back the earliest day's row, so
    // `/notification stats` kept showing the old name for as long as that day
    // was inside the period. The name now comes from the most recent day.
    it('shows the name the channel has now', () => {
      expect(
        voiceSessionRepository.getUserChannelStats(GUILD, USER)[0].channel_name
      ).toBe('New name');
    });
  });

  it('closes leftover open sessions with zero duration at boot', () => {
    const stale = voiceSessionRepository.startSession(
      GUILD,
      USER,
      'vc-a',
      '#a'
    );
    const otherGuild = voiceSessionRepository.startSession(
      'guild-2',
      USER,
      'vc-b',
      '#b'
    );
    const finished = recordSession('vc-c', 60_000);
    vi.advanceTimersByTime(5 * 60_000);

    voiceSessionRepository.closeAllStaleSessions();

    const row = (id: number) =>
      db
        .prepare(
          'SELECT joined_at, left_at, duration_ms FROM voice_sessions WHERE id = ?'
        )
        .get(id) as {
        joined_at: number;
        left_at: number | null;
        duration_ms: number | null;
      };
    // No trustworthy end time: zero duration, not the whole offline window.
    for (const id of [stale, otherGuild]) {
      expect(row(id).left_at).toBe(row(id).joined_at);
      expect(row(id).duration_ms).toBe(0);
    }
    expect(row(finished).duration_ms).toBe(60_000);
    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      60_000
    );
  });

  it('reports how many stale sessions a global sweep closed', () => {
    voiceSessionRepository.startSession(GUILD, USER, 'vc-a', '#a');
    voiceSessionRepository.startSession('guild-2', USER, 'vc-b', '#b');
    recordSession('vc-c', 60_000);

    expect(voiceSessionRepository.closeAllStaleSessions()).toBe(2);
    expect(voiceSessionRepository.closeAllStaleSessions()).toBe(0);
  });

  it('retains open sessions and sessions newer than the retention window', () => {
    const now = Date.now();
    /** A one-minute visit that ended `msAgo` before now. */
    const endedAgo = (channelId: string, msAgo: number) =>
      closedSession(channelId, now - msAgo - MINUTE, MINUTE);

    endedAgo('old', 10 * DAY);
    endedAgo('just-outside', 7.1 * DAY);
    // The cutoff is "strictly older than N days".
    endedAgo('on-cutoff', 7 * DAY);
    endedAgo('just-inside', 6.9 * DAY);
    endedAgo('recent', 2 * DAY);
    // Joined long before the cutoff but only left recently: still kept.
    closedSession('long-visit', now - 10 * DAY, 8 * DAY);
    // Still connected after a month: no end time, so never cleaned up.
    vi.setSystemTime(now - 30 * DAY);
    voiceSessionRepository.startSession(GUILD, USER, 'open', '#open');
    vi.setSystemTime(now);

    expect(voiceSessionRepository.cleanupOldSessions(7)).toBe(2);

    const remaining = (
      db
        .prepare('SELECT channel_id FROM voice_sessions ORDER BY channel_id')
        .all() as Array<{ channel_id: string }>
    ).map((r) => r.channel_id);
    expect(remaining).toEqual([
      'just-inside',
      'long-visit',
      'on-cutoff',
      'open',
      'recent',
    ]);
  });

  it('finds expired sessions through an index rather than a table scan', () => {
    const prepare = vi.spyOn(db, 'prepare');
    voiceSessionRepository.cleanupOldSessions(7);
    const sql = prepare.mock.calls
      .map(([statement]) => statement)
      .find((statement) => statement.startsWith('DELETE FROM voice_sessions'));
    prepare.mockRestore();

    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0, 0) as Array<{
        detail: string;
      }>
    )
      .map((step) => step.detail)
      .join('\n');

    expect(plan).toMatch(/SEARCH voice_sessions USING INDEX/);
  });

  it('orders channel stats by time spent and scopes them to one user', () => {
    recordSession('vc-short', 30_000);
    recordSession('vc-long', 90_000);
    recordSession('vc-short', 30_000);
    const otherUser = voiceSessionRepository.startSession(
      GUILD,
      'user-2',
      'vc-other',
      '#vc-other'
    );
    vi.advanceTimersByTime(600_000);
    voiceSessionRepository.endSession(otherUser);

    expect(voiceSessionRepository.getUserChannelStats(GUILD, USER)).toEqual([
      expect.objectContaining({
        channel_id: 'vc-long',
        total_duration_ms: 90_000,
        session_count: 1,
      }),
      expect.objectContaining({
        channel_id: 'vc-short',
        total_duration_ms: 60_000,
        session_count: 2,
      }),
    ]);
    expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
      150_000
    );
    expect(voiceSessionRepository.getUserTotalDuration('guild-2', USER)).toBe(
      0
    );
  });

  it('returns no channels and a zero total for a user with no history', () => {
    expect(voiceSessionRepository.getUserChannelStats(GUILD, USER)).toEqual([]);
    expect(
      voiceSessionRepository.getUserTotalDuration(
        GUILD,
        USER,
        dayKey(Date.now())
      )
    ).toBe(0);
  });

  describe('day boundaries', () => {
    afterEach(() => {
      setStatsTimeZone(DEFAULT_STATS_TIME_ZONE);
    });

    it('buckets a timestamp by the stats time zone, not the process one', () => {
      // 01:00 on the 16th in Japan is still the 15th in UTC.
      const lateNight = Date.UTC(2026, 0, 15, 16, 0, 0);
      expect(dayKey(lateNight)).toBe('2026-01-16');

      setStatsTimeZone('UTC');
      expect(dayKey(lateNight)).toBe('2026-01-15');
    });

    it('splits a visit that crosses midnight between the two days', () => {
      vi.setSystemTime(JST_MIDNIGHT - 30 * MINUTE);
      recordSession('vc-a', HOUR);

      expect(rollupRows()).toEqual([
        {
          channel_id: 'vc-a',
          day: '2026-07-14',
          total_duration_ms: 30 * MINUTE,
          session_count: 1,
        },
        {
          channel_id: 'vc-a',
          day: '2026-07-15',
          total_duration_ms: 30 * MINUTE,
          // The visit is counted once, on the day it started.
          session_count: 0,
        },
      ]);
      expect(
        voiceSessionRepository.getUserTotalDuration(GUILD, USER, '2026-07-15')
      ).toBe(30 * MINUTE);
      expect(voiceSessionRepository.getUserTotalDuration(GUILD, USER)).toBe(
        HOUR
      );
    });

    it('adds a split visit to rows other visits already started', () => {
      vi.setSystemTime(JST_MIDNIGHT + HOUR);
      recordSession('vc-a', MINUTE);
      vi.setSystemTime(JST_MIDNIGHT - MINUTE);
      recordSession('vc-a', 2 * MINUTE);

      const today = voiceSessionRepository.getUserChannelStats(
        GUILD,
        USER,
        '2026-07-15'
      );
      expect(today).toEqual([
        {
          channel_id: 'vc-a',
          channel_name: '#vc-a',
          total_duration_ms: 2 * MINUTE,
          session_count: 1,
        },
      ]);
    });
  });
});
