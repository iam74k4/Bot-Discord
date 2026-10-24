import { database } from '../../../infrastructure/database/connection.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';

/**
 * Persistence for text-to-speech: each user's voice and the per-server
 * reading dictionary.
 *
 * Reads degrade to "nothing configured" on a database failure so a broken
 * row never stops the bot from reading a message aloud.
 */

export interface TtsUserSettings {
  speakerId: number;
  speed: number;
}

export interface TtsDictionaryEntry {
  word: string;
  reading: string;
  createdBy: string;
}

/** Most entries a server may hold; the whole list is applied to every line. */
export const MAX_DICTIONARY_ENTRIES = 200;

function getUserSettings(userId: string): TtsUserSettings | null {
  try {
    const row = database
      .prepare(
        'SELECT speaker_id, speed FROM tts_user_settings WHERE user_id = ?'
      )
      .get(userId) as { speaker_id: number; speed: number } | undefined;
    return row ? { speakerId: row.speaker_id, speed: row.speed } : null;
  } catch (error) {
    logger.debug(
      `Failed to read TTS settings for ${userId}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

function setUserSettings(userId: string, settings: TtsUserSettings): void {
  database
    .prepare(
      `INSERT INTO tts_user_settings (user_id, speaker_id, speed, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         speaker_id = excluded.speaker_id,
         speed = excluded.speed,
         updated_at = excluded.updated_at`
    )
    .run(userId, settings.speakerId, settings.speed, Date.now());
}

function listDictionary(guildId: string): TtsDictionaryEntry[] {
  try {
    const rows = database
      .prepare(
        'SELECT word, reading, created_by FROM tts_dictionary WHERE guild_id = ? ORDER BY word ASC'
      )
      .all(guildId) as Array<{
      word: string;
      reading: string;
      created_by: string;
    }>;
    return rows.map((row) => ({
      word: row.word,
      reading: row.reading,
      createdBy: row.created_by,
    }));
  } catch (error) {
    logger.debug(
      `Failed to read TTS dictionary for ${guildId}: ${getErrorMessage(error)}`
    );
    return [];
  }
}

function countDictionary(guildId: string): number {
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM tts_dictionary WHERE guild_id = ?')
    .get(guildId) as { count: number };
  return row.count;
}

function getDictionaryEntry(
  guildId: string,
  word: string
): TtsDictionaryEntry | null {
  const row = database
    .prepare(
      'SELECT word, reading, created_by FROM tts_dictionary WHERE guild_id = ? AND word = ?'
    )
    .get(guildId, word) as
    | { word: string; reading: string; created_by: string }
    | undefined;
  return row
    ? { word: row.word, reading: row.reading, createdBy: row.created_by }
    : null;
}

/** Insert or overwrite; returns true when the word was new. */
function upsertDictionaryEntry(
  guildId: string,
  word: string,
  reading: string,
  createdBy: string
): boolean {
  const existed = getDictionaryEntry(guildId, word) !== null;
  database
    .prepare(
      `INSERT INTO tts_dictionary (guild_id, word, reading, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, word) DO UPDATE SET
         word = excluded.word,
         reading = excluded.reading,
         created_by = excluded.created_by,
         created_at = excluded.created_at`
    )
    .run(guildId, word, reading, createdBy, Date.now());
  return !existed;
}

function removeDictionaryEntry(guildId: string, word: string): boolean {
  const result = database
    .prepare('DELETE FROM tts_dictionary WHERE guild_id = ? AND word = ?')
    .run(guildId, word);
  return result.changes > 0;
}

export const ttsRepository = {
  countDictionary,
  getDictionaryEntry,
  getUserSettings,
  listDictionary,
  removeDictionaryEntry,
  setUserSettings,
  upsertDictionaryEntry,
};
