import { database } from '../connection.js';

/**
 * Polls survive restarts. Before this, an active poll lived only in process
 * memory: a deploy silently dropped the tally and its auto-close timer while
 * the message kept showing a live-looking embed with working buttons.
 */
function columnNames(table: string): string[] {
  const columns = database.pragma(`table_info(${table})`) as Array<{
    name: string;
  }>;
  return columns.map((column) => column.name);
}

export function up(): void {
  // 010 rebuilds `polls` for Discord's native polls, and migrations re-run on
  // every boot. Once that schema is in place this migration must leave it
  // alone: its ends_at index would fail with "no such column" and abort
  // startup, and poll_votes would be recreated only for 010 to drop it again.
  const columns = columnNames('polls');
  if (columns.length > 0 && !columns.includes('question')) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS polls (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      anonymous INTEGER NOT NULL DEFAULT 0,
      ends_at INTEGER,
      locale TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      voted_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES polls(message_id) ON DELETE CASCADE
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_polls_guild_id
    ON polls(guild_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_polls_ends_at
    ON polls(ends_at)
  `);
}
