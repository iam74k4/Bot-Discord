import { database } from '../connection.js';

/**
 * Indexes that match the queries the bot actually runs.
 *
 * `voice_sessions` is written on every VC join and leave, and each index adds
 * to that write. Nothing reads the table by guild and user or by guild and
 * channel any more - stats come from `voice_daily_stats` - so those two
 * indexes only cost writes (about 40% of each session's WAL volume). The
 * `joined_at` index stays: the retention DELETE walks it as a range.
 *
 * The audit log view (`/admin settings`, logs tab) asks for one guild's
 * newest rows. With an index on `guild_id` alone SQLite had to sort all of
 * that guild's rows to return a page of them; `(guild_id, created_at)` hands
 * them over already in order (rowid, which breaks ties, is part of every
 * index entry). Its `guild_id` prefix also serves the row count, so it
 * replaces the old index rather than adding one.
 *
 * Every migration re-runs on every boot. 003 and 004 therefore no longer
 * create the indexes dropped here; if they did, each boot would rebuild them
 * only for this migration to drop them again, which costs hundreds of
 * milliseconds on a large table. The DROPs below remove them from databases
 * created before this change and are no-ops afterwards.
 */
export const SUPERSEDED_INDEXES = [
  'idx_voice_sessions_guild_user',
  'idx_voice_sessions_guild_channel',
  'idx_audit_logs_guild_id',
] as const;

export function up(): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_created
    ON audit_logs (guild_id, created_at)
  `);

  for (const name of SUPERSEDED_INDEXES) {
    database.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}
