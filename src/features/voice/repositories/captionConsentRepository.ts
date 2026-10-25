import { database } from '../../../infrastructure/database/connection.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';

/**
 * Persistence for caption consent: whether a member has agreed to have their
 * voice captioned in a server.
 *
 * Asked for every audio chunk of every speaker while captions run, so
 * answers are cached in memory. The bot is the only writer and every write
 * updates the cache. A failed read counts as "no" and is not cached: when
 * in doubt, nobody is captioned.
 */

/** Answers kept in memory; the least recently asked go first. */
const MAX_CACHED = 10_000;

const cache = new Map<string, boolean>();

function keyOf(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function remember(key: string, consented: boolean): void {
  cache.delete(key);
  cache.set(key, consented);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function hasConsented(guildId: string, userId: string): boolean {
  const key = keyOf(guildId, userId);
  const cached = cache.get(key);
  if (cached !== undefined) {
    remember(key, cached);
    return cached;
  }

  try {
    const row = database
      .prepare(
        'SELECT 1 FROM caption_consent WHERE guild_id = ? AND user_id = ?'
      )
      .get(guildId, userId);
    const consented = row !== undefined;
    remember(key, consented);
    return consented;
  } catch (error) {
    logger.debug(
      `Failed to read caption consent for ${userId} in ${guildId}: ${getErrorMessage(error)}`
    );
    return false;
  }
}

/** Record the member's answer; returns true when it changed. */
function setConsent(
  guildId: string,
  userId: string,
  consented: boolean
): boolean {
  const result = consented
    ? database
        .prepare(
          `INSERT INTO caption_consent (guild_id, user_id, consented_at)
           VALUES (?, ?, ?)
           ON CONFLICT(guild_id, user_id) DO NOTHING`
        )
        .run(guildId, userId, Date.now())
    : database
        .prepare(
          'DELETE FROM caption_consent WHERE guild_id = ? AND user_id = ?'
        )
        .run(guildId, userId);
  remember(keyOf(guildId, userId), consented);
  return result.changes > 0;
}

/** Forget everything cached; for tests that write the table directly. */
function clearCache(): void {
  cache.clear();
}

export const captionConsentRepository = {
  clearCache,
  hasConsented,
  setConsent,
};
