import { database } from '../connection.js';

/**
 * Text-to-speech settings.
 *
 * Voice choice follows the person rather than the server - someone who picked
 * a voice once should sound the same everywhere the bot reads for them - so it
 * is keyed by user alone. The reading dictionary is a server's own vocabulary
 * (member nicknames, in-jokes, game terms) and is keyed by guild.
 */
export function up(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tts_user_settings (
      user_id TEXT PRIMARY KEY,
      speaker_id INTEGER NOT NULL,
      speed REAL NOT NULL DEFAULT 1.0,
      updated_at INTEGER NOT NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS tts_dictionary (
      guild_id TEXT NOT NULL,
      word TEXT NOT NULL,
      reading TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, word)
    )
  `);
}
