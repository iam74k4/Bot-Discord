import { database } from '../connection.js';

export function up(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      guild_id TEXT NOT NULL,
      type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, type)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  // The (guild_id, user_id) and (guild_id, channel_id) indexes this used to
  // create had no reader. 012 drops them from older databases; creating them
  // here again would rebuild them on every boot only for 012 to drop them.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_joined_at
    ON voice_sessions(joined_at)
  `);
}
