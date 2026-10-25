import { database } from '../../../infrastructure/database/connection.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import {
  compileDictionary,
  dictionaryKey,
  type CompiledDictionary,
} from '../tts/textNormalizer.js';

/**
 * Persistence for text-to-speech: each user's voice and the per-server
 * reading dictionary.
 *
 * Reads degrade to "nothing configured" on a database failure so a broken
 * row never stops the bot from reading a message aloud.
 *
 * Both are read for every chat message a session reads, so they are cached
 * in memory: the dictionary per server, already compiled into one pattern,
 * and voice settings per user. The bot is the only writer, and every write
 * below drops the affected entry, so the next message sees the change.
 * Failed reads are never cached.
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

/** Users whose voice settings stay cached; the least recently read go first. */
const MAX_CACHED_USERS = 5_000;

interface CachedDictionary {
  entries: readonly TtsDictionaryEntry[];
  compiled: CompiledDictionary;
}

/** null caches "never chose a voice". */
const userSettingsCache = new Map<string, TtsUserSettings | null>();
const dictionaryCache = new Map<string, CachedDictionary>();

function rememberUserSettings(
  userId: string,
  settings: TtsUserSettings | null
): void {
  userSettingsCache.delete(userId);
  userSettingsCache.set(userId, settings);
  if (userSettingsCache.size > MAX_CACHED_USERS) {
    const oldest = userSettingsCache.keys().next().value;
    if (oldest !== undefined) userSettingsCache.delete(oldest);
  }
}

function getUserSettings(userId: string): TtsUserSettings | null {
  if (userSettingsCache.has(userId)) {
    const cached = userSettingsCache.get(userId) ?? null;
    rememberUserSettings(userId, cached);
    return cached ? { ...cached } : null;
  }

  try {
    const row = database
      .prepare(
        'SELECT speaker_id, speed FROM tts_user_settings WHERE user_id = ?'
      )
      .get(userId) as { speaker_id: number; speed: number } | undefined;
    const settings = row
      ? { speakerId: row.speaker_id, speed: row.speed }
      : null;
    rememberUserSettings(userId, settings);
    return settings ? { ...settings } : null;
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
  userSettingsCache.delete(userId);
}

/** The server's dictionary from the cache, read from the database on a miss. */
function loadDictionary(guildId: string): CachedDictionary | null {
  const cached = dictionaryCache.get(guildId);
  if (cached) return cached;

  try {
    const rows = database
      .prepare(
        'SELECT word, reading, created_by FROM tts_dictionary WHERE guild_id = ? ORDER BY word_key ASC'
      )
      .all(guildId) as Array<{
      word: string;
      reading: string;
      created_by: string;
    }>;
    const entries = rows.map((row) => ({
      word: row.word,
      reading: row.reading,
      createdBy: row.created_by,
    }));
    const loaded = { entries, compiled: compileDictionary(entries) };
    dictionaryCache.set(guildId, loaded);
    return loaded;
  } catch (error) {
    logger.debug(
      `Failed to read TTS dictionary for ${guildId}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

function listDictionary(guildId: string): TtsDictionaryEntry[] {
  return (loadDictionary(guildId)?.entries ?? []).map((entry) => ({
    ...entry,
  }));
}

const EMPTY_DICTIONARY: CompiledDictionary = compileDictionary([]);

/** The server's dictionary ready to apply to a message. */
function compiledDictionary(guildId: string): CompiledDictionary {
  return loadDictionary(guildId)?.compiled ?? EMPTY_DICTIONARY;
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
      'SELECT word, reading, created_by FROM tts_dictionary WHERE guild_id = ? AND word_key = ?'
    )
    .get(guildId, dictionaryKey(word)) as
    | { word: string; reading: string; created_by: string }
    | undefined;
  return row
    ? { word: row.word, reading: row.reading, createdBy: row.created_by }
    : null;
}

/**
 * Insert or overwrite; returns true when the word was new. Words are one
 * entry per dictionaryKey, so a case or width variant ("ＡＬＩＣＥ" for
 * "alice") overwrites rather than adds; the latest spelling is shown. An
 * overwrite keeps the original author and date: who may change or remove a
 * word is decided by who added it, so an edit (by them or a server manager)
 * must not hand it to the editor.
 */
function upsertDictionaryEntry(
  guildId: string,
  word: string,
  reading: string,
  createdBy: string
): boolean {
  const existed = getDictionaryEntry(guildId, word) !== null;
  database
    .prepare(
      `INSERT INTO tts_dictionary
         (guild_id, word_key, word, reading, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, word_key) DO UPDATE SET
         word = excluded.word,
         reading = excluded.reading`
    )
    .run(guildId, dictionaryKey(word), word, reading, createdBy, Date.now());
  dictionaryCache.delete(guildId);
  return !existed;
}

function removeDictionaryEntry(guildId: string, word: string): boolean {
  const result = database
    .prepare('DELETE FROM tts_dictionary WHERE guild_id = ? AND word_key = ?')
    .run(guildId, dictionaryKey(word));
  dictionaryCache.delete(guildId);
  return result.changes > 0;
}

/** Drop a server's cached dictionary, e.g. when the bot leaves it. */
function forgetGuild(guildId: string): void {
  dictionaryCache.delete(guildId);
}

/**
 * Forget everything cached. For tests that change the tables directly, and
 * for anything else that writes them behind the repository's back.
 */
function clearCache(): void {
  userSettingsCache.clear();
  dictionaryCache.clear();
}

export const ttsRepository = {
  clearCache,
  compiledDictionary,
  countDictionary,
  forgetGuild,
  getDictionaryEntry,
  getUserSettings,
  listDictionary,
  removeDictionaryEntry,
  setUserSettings,
  upsertDictionaryEntry,
};
