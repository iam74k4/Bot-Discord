import { database } from '../../../infrastructure/database/connection.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';

/**
 * Where a user's running poll lives.
 *
 * Discord owns the poll itself - the question, the answers, who voted, and
 * when it closes. All the bot needs to keep is enough to answer "which message
 * is this user's poll", which is what `/community poll end` asks. Nothing here
 * is authoritative; losing a row costs the creator the shortcut, not the poll.
 */
export interface PollRecord {
  message_id: string;
  guild_id: string;
  channel_id: string;
  creator_id: string;
  expires_at: number;
  created_at: number;
}

function create(record: Omit<PollRecord, 'created_at'>): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO polls
         (message_id, guild_id, channel_id, creator_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.message_id,
      record.guild_id,
      record.channel_id,
      record.creator_id,
      record.expires_at,
      Date.now()
    );
}

/** The creator's most recent poll in this channel that has not expired. */
function findActiveByCreator(
  creatorId: string,
  channelId: string
): PollRecord | null {
  const row = database
    .prepare(
      `SELECT * FROM polls
       WHERE creator_id = ? AND channel_id = ? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(creatorId, channelId, Date.now()) as PollRecord | undefined;

  return row ?? null;
}

/**
 * The creator's most recent open poll anywhere in this server, for
 * `/community poll end` run from a channel that holds none of their polls.
 */
function findActiveByCreatorInGuild(
  creatorId: string,
  guildId: string
): PollRecord | null {
  const row = database
    .prepare(
      `SELECT * FROM polls
       WHERE creator_id = ? AND guild_id = ? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(creatorId, guildId, Date.now()) as PollRecord | undefined;

  return row ?? null;
}

/** The creator's open polls in this server, newest first. */
function listActiveByCreatorInGuild(
  creatorId: string,
  guildId: string,
  limit: number
): PollRecord[] {
  return database
    .prepare(
      `SELECT * FROM polls
       WHERE creator_id = ? AND guild_id = ? AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(creatorId, guildId, Date.now(), limit) as PollRecord[];
}

/** The poll in this message, while it is still open. */
function findActive(messageId: string): PollRecord | null {
  const row = database
    .prepare('SELECT * FROM polls WHERE message_id = ? AND expires_at > ?')
    .get(messageId, Date.now()) as PollRecord | undefined;

  return row ?? null;
}

function remove(messageId: string): void {
  database.prepare('DELETE FROM polls WHERE message_id = ?').run(messageId);
}

/**
 * Forget polls Discord has already closed. Purely housekeeping - every
 * `find*` and `list*` query above already leaves expired rows out.
 */
function removeExpired(): number {
  try {
    return database
      .prepare('DELETE FROM polls WHERE expires_at <= ?')
      .run(Date.now()).changes;
  } catch (error) {
    logger.warn(`Failed to prune expired polls: ${getErrorMessage(error)}`);
    return 0;
  }
}

export const pollRepository = {
  create,
  findActive,
  findActiveByCreator,
  findActiveByCreatorInGuild,
  listActiveByCreatorInGuild,
  remove,
  removeExpired,
};
