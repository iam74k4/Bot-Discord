import type { Guild } from 'discord.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { reconcileGuild, type ReconcileOutcome } from './reconcile.js';

/**
 * The auto-join changes an admin can make, shared by the slash commands,
 * the `/voice status` panel and the opt-out button on the notice, so each
 * entry point behaves the same: turning something off takes effect at once,
 * and turning something on joins an occupied channel right away instead of
 * waiting for the next person to join or leave.
 */

/** Turn auto-join on and join the busiest occupied channel now. */
export async function enableAutoJoin(guild: Guild): Promise<ReconcileOutcome> {
  voiceSettingsRepository.setAutoJoinEnabled(guild.id, true);
  return reconcileGuild(guild);
}

/**
 * Turn auto-join off and leave every voice channel of the guild, dropping
 * the audio kept there.
 * @returns how many connections were dropped
 */
export async function disableAutoJoin(guildId: string): Promise<number> {
  voiceSettingsRepository.setAutoJoinEnabled(guildId, false);
  let dropped = 0;
  for (const [channelId, info] of connectionManager.getAllConnections()) {
    if (info.guildId === guildId) {
      await connectionManager.disconnect(channelId);
      dropped++;
    }
  }
  return dropped;
}

export interface ExcludeResult {
  /** False when the channel was already excluded. */
  added: boolean;
  /** True when the bot was in the channel and left it. */
  left: boolean;
}

/**
 * Exclude a channel and leave it if the bot is there. After leaving, the
 * bot moves on to another occupied channel of the guild, if any.
 */
export async function excludeChannel(
  guild: Guild,
  channelId: string
): Promise<ExcludeResult> {
  const { added, left } = await applyExclusionChanges(guild, [channelId], []);
  return { added: added.length > 0, left };
}

export interface ExclusionChanges {
  /** Channels that were not excluded before (already excluded ones are left out). */
  added: string[];
  /** Channels that were excluded before. */
  removed: string[];
  /** True when the bot was in one of the newly excluded channels and left. */
  left: boolean;
  /** Present when the guild was reconciled afterwards. */
  outcome?: ReconcileOutcome;
}

/**
 * Exclude and re-include several channels as one change, as the
 * `/voice status` menu submits them.
 *
 * The whole new list is stored before the bot moves: leaving one newly
 * excluded channel and reconciling right away would otherwise join another
 * channel that is excluded in the same change a moment later - popping into
 * it and posting a notice there in the very action meant to opt it out.
 * The guild is reconciled once, at the end, and only when the bot left or a
 * channel became eligible again.
 */
export async function applyExclusionChanges(
  guild: Guild,
  exclude: readonly string[],
  include: readonly string[]
): Promise<ExclusionChanges> {
  const added = exclude.filter((id) =>
    voiceSettingsRepository.addExclusion(guild.id, id)
  );
  const removed = include.filter((id) =>
    voiceSettingsRepository.removeExclusion(guild.id, id)
  );

  let left = false;
  for (const channelId of exclude) {
    if (connectionManager.getConnection(channelId)) {
      await connectionManager.disconnect(channelId);
      left = true;
    }
  }

  if (!left && removed.length === 0) return { added, removed, left };
  return { added, removed, left, outcome: await reconcileGuild(guild) };
}

export interface IncludeResult {
  /** False when the channel was not excluded. */
  removed: boolean;
  /** Present when auto-join is on and the guild was reconciled. */
  outcome?: ReconcileOutcome;
}

/** Re-include a channel and join an occupied channel if auto-join is on. */
export async function includeChannel(
  guild: Guild,
  channelId: string
): Promise<IncludeResult> {
  const removed = voiceSettingsRepository.removeExclusion(guild.id, channelId);
  if (!removed || !voiceSettingsRepository.isAutoJoinEnabled(guild.id)) {
    return { removed };
  }
  return { removed, outcome: await reconcileGuild(guild) };
}
