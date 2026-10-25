import { database } from '../connection.js';

export function up(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      language TEXT DEFAULT 'ja',
      audit_channel_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // 012 replaces the `guild_id` index this used to create with one on
  // (guild_id, created_at). Creating the old one here again would rebuild it
  // on every boot only for 012 to drop it.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON audit_logs(created_at)
  `);
}
