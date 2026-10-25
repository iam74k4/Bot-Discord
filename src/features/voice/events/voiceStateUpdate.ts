import { Events, VoiceChannel, VoiceState, StageChannel } from 'discord.js';
import { Event } from '../../../shared/types/index.js';
import { ExtendedClient } from '../../../client.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import {
  announceBuffering,
  forgetAnnouncement,
} from '../application/announce.js';
import { reconcileGuild } from '../application/reconcile.js';
import { logger } from '../../../shared/utils/logger.js';
import { isGuildAllowed } from '../../../shared/utils/guildAllowlist.js';

function humanMemberCount(
  channel: VoiceChannel | StageChannel | null | undefined
): number {
  if (!channel) return 0;
  return channel.members.filter((member) => !member.user.bot).size;
}

/**
 * Voice State Update event handler
 */
export const event: Event<typeof Events.VoiceStateUpdate> = {
  name: Events.VoiceStateUpdate,
  once: false,
  async execute(
    client: ExtendedClient,
    oldState: VoiceState,
    newState: VoiceState
  ) {
    if (!client.isFullyReady) return;

    if (newState.member?.user.id === client.user?.id) {
      await handleBotVoiceState(oldState, newState);
      return;
    }

    // User joined a voice channel
    if (!oldState.channel && newState.channel) {
      await handleUserJoined(client, newState);
    }

    // User left a voice channel
    if (oldState.channel && !newState.channel) {
      const disconnected = await handleUserLeft(client, oldState);
      // The bot's channel emptied; people may still be talking in another
      // channel of this guild, which nothing else would make it join.
      if (disconnected && oldState.guild) {
        await reconcileGuild(oldState.guild);
      }
    }

    // User moved to a different channel
    if (
      oldState.channel &&
      newState.channel &&
      oldState.channel.id !== newState.channel.id
    ) {
      await handleUserMoved(client, oldState, newState);
    }
  },
};

/**
 * Keep connectionManager keys aligned when the bot is moved/disconnected
 * outside connect()/disconnect(). Ignoring bot VSUs leaves maps/mix rings on
 * the old channelId while the live VoiceConnection is elsewhere.
 */
async function handleBotVoiceState(
  oldState: VoiceState,
  newState: VoiceState
): Promise<void> {
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  if (!oldChannel || (newChannel && oldChannel.id === newChannel.id)) {
    return;
  }

  if (connectionManager.getConnection(oldChannel.id)) {
    logger.info(
      `Bot left/moved from tracked channel ${oldChannel.name} (${oldChannel.id}); cleaning up`
    );
    await connectionManager.disconnect(oldChannel.id);
  }
  forgetAnnouncement(oldChannel.id);

  // Admin move A→B: reconnect on B when humans are present so recording
  // continues. Skip when newChannel is null (kick/disconnect).
  if (
    newChannel &&
    humanMemberCount(newChannel) > 0 &&
    !connectionManager.getConnection(newChannel.id) &&
    !connectionManager.isAtLimit() &&
    voiceSettingsRepository.mayAutoJoin(newState.guild.id, newChannel.id)
  ) {
    const connection = await connectionManager.connect(
      newState.guild,
      newChannel
    );
    if (connection) {
      logger.info(
        `Re-tracked bot after move into ${newChannel.name} (${newChannel.id})`
      );
      await announceBuffering(newChannel);
    }
  }
}

/**
 * Handle user joining a voice channel
 */
async function handleUserJoined(
  _client: ExtendedClient,
  state: VoiceState
): Promise<void> {
  if (!state.channel || !state.guild) return;

  const channel = state.channel;
  const guild = state.guild;

  // Another bot (a music bot, say) joining is not a conversation to keep.
  // Checking before connecting matters: connecting first and leaving again
  // would hold the guild's one voice slot and could block a human's join.
  if (humanMemberCount(channel) === 0) {
    return;
  }

  // Check if bot is already connected to this channel
  const existingConnection = connectionManager.getConnection(channel.id);
  if (existingConnection) {
    connectionManager.updateActivity(channel.id);
    return;
  }

  // Buffering everyone's audio is opt-out per guild and per channel, and
  // never happens in a server outside ALLOWED_GUILD_IDS.
  if (
    !isGuildAllowed(guild.id) ||
    !voiceSettingsRepository.mayAutoJoin(guild.id, channel.id)
  ) {
    logger.debug(
      `Auto-join disabled for ${channel.name} (${channel.id}) in guild ${guild.id}`
    );
    return;
  }

  // Discord allows one voice connection per guild. Staying on the current
  // channel avoids joinVoiceChannel moving the shared connection and
  // cross-wiring per-channel mix rings.
  const busyChannelId = connectionManager.getConnectedChannelInGuild(guild.id);
  if (busyChannelId) {
    logger.debug(
      `Already connected in guild ${guild.id} (channel ${busyChannelId}); skipping auto-join of ${channel.name} (${channel.id})`
    );
    return;
  }

  // Check connection limit
  if (connectionManager.isAtLimit()) {
    logger.warn(
      `Connection limit reached. Cannot auto-join channel ${channel.name} (${channel.id})`
    );
    return;
  }

  const connection = await connectionManager.connect(guild, channel);
  if (!connection) {
    logger.warn(
      `Failed to auto-join voice channel ${channel.name} (${channel.id}) in guild ${guild.name}`
    );
    return;
  }

  // Leave can race the await above: handleUserLeft sees no connection yet and
  // returns, then connect lands in an empty channel and holds a slot forever.
  if (humanMemberCount(channel) === 0) {
    logger.info(
      `Channel ${channel.name} (${channel.id}) emptied during connect. Disconnecting...`
    );
    await connectionManager.disconnect(channel.id);
    return;
  }

  logger.info(
    `Auto-joined voice channel ${channel.name} (${channel.id}) in guild ${guild.name}`
  );

  await announceBuffering(channel);
}

/**
 * Handle user leaving a voice channel
 * @returns true when the bot left the channel because nobody was left
 */
async function handleUserLeft(
  _client: ExtendedClient,
  state: VoiceState
): Promise<boolean> {
  if (!state.channel || !state.guild) return false;

  const channel = state.channel;

  // Check if bot is connected to this channel
  const connection = connectionManager.getConnection(channel.id);
  if (!connection) return false;

  if (humanMemberCount(channel) > 0) return false;

  // No users left, disconnect
  logger.info(
    `No users left in channel ${channel.name} (${channel.id}). Disconnecting...`
  );
  await connectionManager.disconnect(channel.id);
  forgetAnnouncement(channel.id);
  return true;
}

/**
 * Handle user moving to a different channel
 */
async function handleUserMoved(
  client: ExtendedClient,
  oldState: VoiceState,
  newState: VoiceState
): Promise<void> {
  // Handle leaving old channel
  const disconnected = await handleUserLeft(client, oldState);

  // Handle joining new channel: the bot follows the user when it can.
  await handleUserJoined(client, newState);

  // It could not follow (excluded channel, say) and left its old channel:
  // pick up whichever channel of the guild is still occupied.
  const guild = newState.guild;
  if (
    disconnected &&
    guild &&
    !connectionManager.getConnectedChannelInGuild(guild.id)
  ) {
    await reconcileGuild(guild);
  }
}
