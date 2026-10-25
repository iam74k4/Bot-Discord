import {
  ChannelType,
  Client,
  type Guild,
  StageChannel,
  VoiceChannel,
} from 'discord.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { announceBuffering } from './announce.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { isGuildAllowed } from '../../../shared/utils/guildAllowlist.js';

function humanMemberCount(channel: VoiceChannel | StageChannel): number {
  return channel.members.filter((member) => !member.user.bot).size;
}

function isJoinableVoiceChannel(
  channel: unknown
): channel is VoiceChannel | StageChannel {
  if (!channel || typeof channel !== 'object') return false;
  const typed = channel as { type?: number; members?: unknown };
  return (
    (typed.type === ChannelType.GuildVoice ||
      typed.type === ChannelType.GuildStageVoice) &&
    typed.members != null
  );
}

/** What reconciling one guild did. */
export type ReconcileOutcome =
  | { status: 'joined'; channelId: string }
  | { status: 'already'; channelId: string }
  | { status: 'none' }
  | { status: 'disabled' }
  | { status: 'limit' }
  | { status: 'failed' };

/** The occupied, non-excluded voice channel with the most humans in it. */
function busiestEligibleChannel(
  guild: Guild
): VoiceChannel | StageChannel | null {
  let bestChannel: VoiceChannel | StageChannel | null = null;
  let bestCount = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!isJoinableVoiceChannel(channel)) continue;
    if (voiceSettingsRepository.isChannelExcluded(guild.id, channel.id))
      continue;
    const count = humanMemberCount(channel);
    if (count > bestCount) {
      bestChannel = channel;
      bestCount = count;
    }
  }

  return bestChannel;
}

/**
 * Join the busiest occupied voice channel of one guild if auto-join allows
 * it and the bot is not in any of its channels yet.
 *
 * Used at startup, when a guild is added, right after an admin turns
 * auto-join on or re-includes a channel, and when the bot's channel empties
 * while people are still talking elsewhere - each a moment where waiting for
 * someone to join or leave would leave a conversation unrecorded.
 *
 * The disclosure is posted without waiting for it, so one slow message does
 * not hold up the next guild's voice handshake.
 */
export async function reconcileGuild(guild: Guild): Promise<ReconcileOutcome> {
  // Discord allows one voice connection per guild.
  const connectedChannelId = connectionManager.getConnectedChannelInGuild(
    guild.id
  );
  if (connectedChannelId) {
    return { status: 'already', channelId: connectedChannelId };
  }

  if (connectionManager.isAtLimit()) {
    return { status: 'limit' };
  }

  // A server outside ALLOWED_GUILD_IDS is not served, so never auto-joined
  // (the bot may still be in it; see the ready event).
  if (
    !isGuildAllowed(guild.id) ||
    !voiceSettingsRepository.isAutoJoinEnabled(guild.id)
  ) {
    return { status: 'disabled' };
  }

  const bestChannel = busiestEligibleChannel(guild);
  if (!bestChannel) {
    return { status: 'none' };
  }

  try {
    const connection = await connectionManager.connect(guild, bestChannel);
    if (!connection) {
      logger.warn(
        `Voice reconcile failed to connect to ${bestChannel.name} (${bestChannel.id}) in guild ${guild.name}`
      );
      return { status: 'failed' };
    }

    // Membership can change while connect awaits; do not hold empty slots.
    if (humanMemberCount(bestChannel) === 0) {
      logger.info(
        `Channel ${bestChannel.name} (${bestChannel.id}) emptied during reconcile. Disconnecting...`
      );
      await connectionManager.disconnect(bestChannel.id);
      return { status: 'none' };
    }

    logger.info(
      `Reconciled voice connection to ${bestChannel.name} (${bestChannel.id}) in guild ${guild.name}`
    );

    void announceBuffering(bestChannel);
    return { status: 'joined', channelId: bestChannel.id };
  } catch (error) {
    logger.error(
      `Voice reconcile error for guild ${guild.id}:`,
      getErrorMessage(error)
    );
    return { status: 'failed' };
  }
}

/**
 * After restart, Discord does not replay join transitions for users already in
 * VC. Without this scan the bot never auto-joins occupied channels until
 * someone joins/leaves/moves — breaking `/voice record` for the whole
 * downtime gap.
 *
 * Discord allows one voice connection per guild; when multiple channels are
 * occupied we join the one with the most human members.
 */
export async function reconcileOccupiedVoiceChannels(
  client: Client
): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const outcome = await reconcileGuild(guild);
    if (outcome.status === 'limit') {
      logger.warn(
        'Connection limit reached during voice reconcile; stopping early'
      );
      return;
    }
  }
}
