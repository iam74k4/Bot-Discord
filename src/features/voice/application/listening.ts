import type { Guild } from 'discord.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { announceBuffering } from './announce.js';

/**
 * Turn a connection that keeps no audio - deafened for reading aloud, or
 * listening only for captions - into the buffering one auto-join would have
 * made, if auto-join now covers the channel and people are in it. In place:
 * the bot does not leave, and members are told it is keeping audio. False
 * when the channel is not auto-join's to take, and the caller decides what
 * becomes of the connection.
 */
export async function resumeAutoJoin(
  guild: Guild,
  voiceChannelId: string
): Promise<boolean> {
  const channel = guild.channels.cache.get(voiceChannelId);
  if (
    !channel?.isVoiceBased() ||
    !voiceSettingsRepository.mayAutoJoin(guild.id, voiceChannelId) ||
    channel.members.filter((member) => !member.user.bot).size === 0 ||
    !connectionManager.enableReceive(voiceChannelId)
  ) {
    return false;
  }
  // Not awaited: a slow or rate-limited post must not hold up the reply past
  // Discord's 3 s window. announceBuffering catches its own errors.
  void announceBuffering(channel);
  return true;
}
