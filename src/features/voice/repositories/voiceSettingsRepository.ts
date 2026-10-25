import { database } from '../../../infrastructure/database/connection.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';

/**
 * Voice auto-join policy.
 *
 * The per-guild on/off switch lives in shared guild settings (several
 * features read that row), while the channel exclusion list is owned here
 * because nothing outside voice uses it.
 */
function isAutoJoinEnabled(guildId: string): boolean {
  return guildSettingsRepository.isVoiceAutoJoinEnabled(guildId);
}

function setAutoJoinEnabled(guildId: string, enabled: boolean): void {
  guildSettingsRepository.setVoiceAutoJoinEnabled(guildId, enabled);
}

function isChannelExcluded(guildId: string, channelId: string): boolean {
  try {
    const row = database
      .prepare(
        'SELECT 1 as found FROM voice_autojoin_exclusions WHERE guild_id = ? AND channel_id = ?'
      )
      .get(guildId, channelId);
    return row !== undefined;
  } catch (error) {
    logger.debug(
      `Failed to read auto-join exclusions for ${guildId}: ${getErrorMessage(error)}`
    );
    return false;
  }
}

/** @returns true when the channel was not excluded before */
function addExclusion(guildId: string, channelId: string): boolean {
  const result = database
    .prepare(
      `INSERT OR IGNORE INTO voice_autojoin_exclusions (guild_id, channel_id, created_at)
       VALUES (?, ?, ?)`
    )
    .run(guildId, channelId, Date.now());
  return result.changes > 0;
}

function removeExclusion(guildId: string, channelId: string): boolean {
  const result = database
    .prepare(
      'DELETE FROM voice_autojoin_exclusions WHERE guild_id = ? AND channel_id = ?'
    )
    .run(guildId, channelId);
  return result.changes > 0;
}

function listExclusions(guildId: string): string[] {
  try {
    const rows = database
      .prepare(
        'SELECT channel_id FROM voice_autojoin_exclusions WHERE guild_id = ? ORDER BY created_at ASC'
      )
      .all(guildId) as Array<{ channel_id: string }>;
    return rows.map((row) => row.channel_id);
  } catch (error) {
    logger.debug(
      `Failed to list auto-join exclusions for ${guildId}: ${getErrorMessage(error)}`
    );
    return [];
  }
}

/** True when the bot is allowed to buffer audio in this specific channel. */
function mayAutoJoin(guildId: string, channelId: string): boolean {
  return isAutoJoinEnabled(guildId) && !isChannelExcluded(guildId, channelId);
}

export const voiceSettingsRepository = {
  addExclusion,
  isAutoJoinEnabled,
  isChannelExcluded,
  listExclusions,
  mayAutoJoin,
  removeExclusion,
  setAutoJoinEnabled,
};
