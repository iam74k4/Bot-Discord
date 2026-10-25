import type { Guild } from 'discord.js';
import {
  mapDiscordLocale,
  t,
  type TranslationKey,
} from '../../../locales/index.js';
import { resolveGuildLocale } from '../../../locales/guildLocale.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import type { VoiceConnectionInfo } from '../../../shared/types/voice.js';
import { connectionManager } from '../recording/connectionManager.js';
import { keepsAudio } from '../recording/audioMode.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { ttsSessions } from '../tts/sessionManager.js';
import { captionSessions } from '../captions/sessionManager.js';
import { reconcileGuild, type ReconcileOutcome } from './reconcile.js';

/**
 * The auto-join changes an admin can make, shared by the slash commands,
 * the `/voice status` panel and the opt-out button on the notice, so each
 * entry point behaves the same: turning something off takes effect at once,
 * and turning something on joins an occupied channel right away instead of
 * waiting for the next person to join or leave.
 */

/**
 * Stop the buffering in one channel. A join that keeps no audio - deafened
 * for text-to-speech, or listening only for captions - is left alone and
 * goes on. A buffering connection is dropped at once - the opt-out wins over
 * reading or captioning through it - and if either was running, the people
 * there are told why and how to resume.
 */
async function stopBuffering(
  guild: Guild,
  channelId: string,
  info: VoiceConnectionInfo
): Promise<{ dropped: boolean; readingStopped: boolean }> {
  if (!keepsAudio(info)) return { dropped: false, readingStopped: false };
  // Checked first: the disconnect ends the sessions.
  const readingStopped = ttsSessions.get(channelId) !== undefined;
  const captionsStopped = captionSessions.get(channelId) !== undefined;
  // Only this connection: one that replaced it meanwhile (say, a deafened
  // /tts start join) is not ours to remove.
  await connectionManager.disconnect(channelId, info.connection);
  // Not awaited: a slow or rate-limited post must neither keep the bot
  // buffering nor hold up the caller's reply. They catch their own errors.
  if (readingStopped) {
    void noticeStopped(guild, channelId, 'tts.stopped', 'tts.stoppedByOptOut');
  }
  if (captionsStopped) {
    void noticeStopped(
      guild,
      channelId,
      'captions.stopped',
      'captions.stoppedByOptOut'
    );
  }
  return { dropped: true, readingStopped };
}

/** Best effort: a missing permission must not keep the bot buffering. */
async function noticeStopped(
  guild: Guild,
  channelId: string,
  titleKey: TranslationKey,
  descriptionKey: TranslationKey
): Promise<void> {
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isSendable()) return;
    const locale = resolveGuildLocale(
      guild.id,
      mapDiscordLocale(guild.preferredLocale)
    );
    await channel.send({
      embeds: [
        createEmbed({
          title: t(titleKey, locale),
          description: t(descriptionKey, locale),
          color: COLORS.WARNING,
        }),
      ],
    });
  } catch (error) {
    logger.debug(
      `Could not tell ${channelId} a session stopped: ${getErrorMessage(error)}`
    );
  }
}

/** Turn auto-join on and join the busiest occupied channel now. */
export async function enableAutoJoin(guild: Guild): Promise<ReconcileOutcome> {
  voiceSettingsRepository.setAutoJoinEnabled(guild.id, true);
  return reconcileGuild(guild);
}

export interface DisableResult {
  /** How many buffering connections were dropped. */
  dropped: number;
  /** Channels where dropping a connection also ended reading aloud. */
  readingStoppedIn: string[];
}

/**
 * Turn auto-join off and stop buffering in every voice channel of the guild,
 * dropping the audio kept there. Deafened text-to-speech joins keep nothing
 * and stay (see stopBuffering).
 */
export async function disableAutoJoin(guild: Guild): Promise<DisableResult> {
  voiceSettingsRepository.setAutoJoinEnabled(guild.id, false);
  const result: DisableResult = { dropped: 0, readingStoppedIn: [] };
  for (const [channelId, info] of connectionManager.getAllConnections()) {
    if (info.guildId !== guild.id) continue;
    const { dropped, readingStopped } = await stopBuffering(
      guild,
      channelId,
      info
    );
    if (dropped) result.dropped++;
    if (readingStopped) result.readingStoppedIn.push(channelId);
  }
  return result;
}

export interface ExcludeResult {
  /** False when the channel was already excluded. */
  added: boolean;
  /** True when the bot was buffering the channel and left it. */
  left: boolean;
  /** True when leaving also ended reading aloud there. */
  readingStopped: boolean;
}

/**
 * Exclude a channel and leave it if the bot is there. After leaving, the
 * bot moves on to another occupied channel of the guild, if any.
 */
export async function excludeChannel(
  guild: Guild,
  channelId: string
): Promise<ExcludeResult> {
  const { added, left, readingStoppedIn } = await applyExclusionChanges(
    guild,
    [channelId],
    []
  );
  return {
    added: added.length > 0,
    left,
    readingStopped: readingStoppedIn !== undefined,
  };
}

export interface ExclusionChanges {
  /** Channels that were not excluded before (already excluded ones are left out). */
  added: string[];
  /** Channels that were excluded before. */
  removed: string[];
  /** True when the bot was buffering a newly excluded channel and left. */
  left: boolean;
  /** Channels where leaving also ended reading aloud; absent when none. */
  readingStoppedIn?: string[];
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
  const readingStoppedIn: string[] = [];
  for (const channelId of exclude) {
    const info = connectionManager.getConnection(channelId);
    if (!info) continue;
    const { dropped, readingStopped } = await stopBuffering(
      guild,
      channelId,
      info
    );
    if (dropped) left = true;
    if (readingStopped) readingStoppedIn.push(channelId);
  }

  const changes: ExclusionChanges = {
    added,
    removed,
    left,
    ...(readingStoppedIn.length > 0 && { readingStoppedIn }),
  };
  if (!left && removed.length === 0) return changes;
  return { ...changes, outcome: await reconcileGuild(guild) };
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
