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
const { up: createVoiceSessions } =
  await import('../../../infrastructure/database/migrations/004_notification.js');
const { up: createDailyStats } =
  await import('../../../infrastructure/database/migrations/009_voice_daily_stats.js');

const GUILD = 'guild-1';
const USER = 'user-1';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Local noon: tests that expect several visits in one daily row must not
// straddle midnight, which an unpinned fake clock would do near 23:59.
const NOON = new Date(2026, 6, 15, 12, 0, 0);

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
      voiceSessionRepository.getUserTotalDuration(GUILD, USER, now - dayMs)
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

    // KNOWN BUG (voiceSessionRepository.ts getUserChannelStats): it selects a
    // bare `channel_name` under `GROUP BY channel_id`, so SQLite returns the
    // name from an arbitrary row of the group - in practice the earliest day
    // today - and `/notification stats` can keep showing an old name. Drop
    // `.fails` only once the query explicitly picks the most recent day's
    // name, not because SQLite happens to pick a different row.
    it.fails('shows the name the channel has now', () => {
      expect(
        voiceSessionRepository.getUserChannelStats(GUILD, USER)[0].channel_name
      ).toBe('New name');
    });
  });

  it('closes only the stale sessions of the guild being swept', () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
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

    expect(voiceSessionRepository.closeStaleSessionsForGuild(GUILD)).toBe(1);

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
    expect(row(stale).left_at).toBe(row(stale).joined_at);
    expect(row(stale).duration_ms).toBe(0);
    expect(row(otherGuild).left_at).toBeNull();
    expect(row(finished).duration_ms).toBe(60_000);
    expect(voiceSessionRepository.closeStaleSessionsForGuild(GUILD)).toBe(0);
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
    expect(remaining).toEqual(['just-inside', 'on-cutoff', 'open', 'recent']);
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
      voiceSessionRepository.getUserTotalDuration(GUILD, USER, Date.now())
    ).toBe(0);
  });

  it('buckets a timestamp by the process timezone', () => {
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    expect(dayKey(noon)).toBe('2026-01-15');
  });
});
