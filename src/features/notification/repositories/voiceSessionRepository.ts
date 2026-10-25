import { database } from '../../../infrastructure/database/connection.js';
import { runTransaction } from '../../../infrastructure/database/transaction.js';
import { daySegments } from '../stats/calendar.js';

/** Day keys come from the stats calendar; re-exported for callers and tests. */
export { dayKey } from '../stats/calendar.js';

interface VoiceSessionRecord {
  guild_id: string;
  user_id: string;
  channel_id: string;
  channel_name: string;
  joined_at: number;
  duration_ms: number | null;
}

export interface ChannelStats {
  channel_id: string;
  channel_name: string;
  total_duration_ms: number;
  session_count: number;
}

function startSession(
  guildId: string,
  userId: string,
  channelId: string,
  channelName: string
): number {
  const now = Date.now();
  const stmt = database.prepare(
    'INSERT INTO voice_sessions (guild_id, user_id, channel_id, channel_name, joined_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(guildId, userId, channelId, channelName, now, now);
  return Number(result.lastInsertRowid);
}

/**
 * Close a session and fold its duration into the daily rollup.
 *
 * Both steps run in one transaction: a session counted in `voice_sessions` but
 * missing from the rollup would silently vanish from stats once retention
 * deleted the raw row. A visit that crosses midnight (in the stats zone) is
 * split across the days it covers, so "today" holds only today's minutes; the
 * visit itself is counted once, on the day it started.
 */
function endSession(sessionId: number): void {
  const now = Date.now();

  runTransaction(() => {
    // No row back means it was already closed by a stale-session sweep or a
    // duplicate end: its duration is either counted or deliberately zero, so
    // adding it again would inflate.
    const session = database
      .prepare(
        `UPDATE voice_sessions SET left_at = ?, duration_ms = ? - joined_at
         WHERE id = ? AND left_at IS NULL
         RETURNING guild_id, user_id, channel_id, channel_name, joined_at, duration_ms`
      )
      .get(now, now, sessionId) as VoiceSessionRecord | undefined;

    if (!session?.duration_ms || session.duration_ms <= 0) return;

    const upsert = database.prepare(
      `INSERT INTO voice_daily_stats (
         guild_id, user_id, channel_id, channel_name, day,
         total_duration_ms, session_count, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, channel_id, day) DO UPDATE SET
         total_duration_ms = total_duration_ms + excluded.total_duration_ms,
         session_count = session_count + excluded.session_count,
         channel_name = excluded.channel_name,
         updated_at = excluded.updated_at`
    );

    const segments = daySegments(
      session.joined_at,
      session.joined_at + session.duration_ms
    );
    segments.forEach((segment, index) => {
      upsert.run(
        session.guild_id,
        session.user_id,
        session.channel_id,
        session.channel_name,
        segment.day,
        segment.durationMs,
        index === 0 ? 1 : 0,
        now
      );
    });
  });
}

function closeAllStaleSessions(): number {
  // Crash / hard-kill leftovers have no trustworthy end time. Attribute zero
  // duration instead of charging the entire offline window to the user.
  const stmt = database.prepare(
    'UPDATE voice_sessions SET left_at = joined_at, duration_ms = 0 WHERE left_at IS NULL'
  );
  const result = stmt.run();
  return result.changes;
}

/**
 * Delete closed sessions that ended more than `daysToKeep` days ago.
 *
 * `left_at >= joined_at` always holds (an end sets it to now, the stale sweep
 * to `joined_at`), so the `joined_at` bound removes nothing the `left_at` one
 * keeps; it lets SQLite walk an index range instead of scanning the table.
 */
function cleanupOldSessions(daysToKeep: number): number {
  const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  const stmt = database.prepare(
    'DELETE FROM voice_sessions WHERE joined_at < ? AND left_at IS NOT NULL AND left_at < ?'
  );
  const result = stmt.run(cutoffTime, cutoffTime);
  return result.changes;
}

/**
 * Stats read the rollup, never the raw sessions.
 *
 * Totals therefore cover the bot's whole history rather than stopping at
 * `VOICE_SESSION_RETENTION_DAYS`, and a period starts on a whole day: `since`
 * is a `YYYY-MM-DD` day key in the stats zone (see `stats/calendar.ts`). The
 * filter is a prefix of `idx_voice_daily_stats_lookup (guild_id, user_id,
 * day)`, so a period reads only its own days.
 */
function statsFilter(
  guildId: string,
  userId: string,
  since?: string
): { where: string; params: string[] } {
  const params = [guildId, userId];
  let where = 'WHERE guild_id = ? AND user_id = ?';

  if (since !== undefined) {
    where += ' AND day >= ?';
    params.push(since);
  }

  return { where, params };
}

function getUserChannelStats(
  guildId: string,
  userId: string,
  since?: string
): ChannelStats[] {
  const { where, params } = statsFilter(guildId, userId, since);

  // With a single MAX() in the select list, SQLite takes the bare
  // `channel_name` from the row holding that maximum - the most recent day -
  // so a renamed channel shows its current name rather than its first one.
  const stmt = database.prepare(`
    SELECT
      channel_id,
      channel_name,
      MAX(day) as last_day,
      SUM(total_duration_ms) as total_duration_ms,
      SUM(session_count) as session_count
    FROM voice_daily_stats
    ${where}
    GROUP BY channel_id
    ORDER BY total_duration_ms DESC
  `);

  const rows = stmt.all(...params) as Array<
    ChannelStats & { last_day: string }
  >;
  return rows.map((row) => ({
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    total_duration_ms: row.total_duration_ms,
    session_count: row.session_count,
  }));
}

function getUserTotalDuration(
  guildId: string,
  userId: string,
  since?: string
): number {
  const { where, params } = statsFilter(guildId, userId, since);

  const stmt = database.prepare(`
    SELECT COALESCE(SUM(total_duration_ms), 0) as total
    FROM voice_daily_stats
    ${where}
  `);

  const row = stmt.get(...params) as { total: number };
  return row.total;
}

export const voiceSessionRepository = {
  cleanupOldSessions,
  startSession,
  endSession,
  closeAllStaleSessions,
  getUserChannelStats,
  getUserTotalDuration,
};
