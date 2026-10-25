import { database } from '../connection.js';

/**
 * Who has agreed to have their voice captioned.
 *
 * Captions send a member's speech to a speech recognition engine and post
 * the text in the voice channel's chat, so nobody is captioned until they
 * say yes. The answer is per server - someone may be glad of captions among
 * friends and not want them in a work server - and a row exists only while
 * the answer is yes: withdrawing deletes it, so "no" and "never asked" are
 * the same thing.
 */
export function up(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS caption_consent (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      consented_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
}
