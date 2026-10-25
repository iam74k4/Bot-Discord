import {
  type Guild,
  PermissionFlagsBits,
  type StageChannel,
  type VoiceChannel,
} from 'discord.js';
import { env } from '../../../config/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';

/**
 * Why the bot is not keeping a channel's audio, most actionable first.
 *
 * - `autoJoinOff`: the server turned auto-join off.
 * - `excluded`: this channel is on the exclusion list.
 * - `busyElsewhere`: the bot is in another voice channel of the same server
 *   (Discord allows one voice connection per server).
 * - `readOnly`: the bot is here only to read chat aloud and keeps nothing.
 * - `atLimit`: the bot is in as many channels as it may be, across servers.
 * - `noPermission`: the bot cannot see or connect to the channel.
 * - `notYetJoined`: nothing stops it; the bot simply has not joined yet
 *   (invited while people were already talking, kicked from the channel,
 *   or its previous channel emptied while people stayed here).
 */
export type BufferingGap =
  | { reason: 'autoJoinOff' }
  | { reason: 'excluded' }
  | { reason: 'busyElsewhere'; otherChannelId: string }
  | { reason: 'readOnly' }
  | { reason: 'atLimit' }
  | { reason: 'noPermission' }
  | { reason: 'notYetJoined' };

/** True when the bot holds a connection here that buffers audio. */
export function isBuffering(channelId: string): boolean {
  const connection = connectionManager.getConnection(channelId);
  return connection !== undefined && connection.receiving !== false;
}

/**
 * Explain why `channel` is not buffered; call it only when `isBuffering`
 * is false. Read-only: checks settings, the live connections and the bot's
 * permissions, and changes nothing.
 */
export function diagnoseBufferingGap(
  guild: Pick<Guild, 'id' | 'members'>,
  channel: Pick<VoiceChannel | StageChannel, 'id' | 'permissionsFor'>
): BufferingGap {
  if (!voiceSettingsRepository.isAutoJoinEnabled(guild.id)) {
    return { reason: 'autoJoinOff' };
  }
  if (voiceSettingsRepository.isChannelExcluded(guild.id, channel.id)) {
    return { reason: 'excluded' };
  }

  const connectedChannelId = connectionManager.getConnectedChannelInGuild(
    guild.id
  );
  if (connectedChannelId && connectedChannelId !== channel.id) {
    return { reason: 'busyElsewhere', otherChannelId: connectedChannelId };
  }
  if (connectedChannelId === channel.id) {
    // Connected here but not receiving: a text-to-speech-only join.
    return { reason: 'readOnly' };
  }

  if (connectionManager.isAtLimit()) {
    return { reason: 'atLimit' };
  }

  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor(me) : null;
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.Connect)
  ) {
    return { reason: 'noPermission' };
  }

  return { reason: 'notYetJoined' };
}

/** One sentence (or two) telling an admin why and what to do about it. */
export function describeBufferingGap(
  gap: BufferingGap,
  channelId: string,
  locale: Locale
): string {
  switch (gap.reason) {
    case 'autoJoinOff':
      return t('record.notBuffered.autoJoinOff', locale, {
        command: commandMention('voice autojoin enable'),
      });
    case 'excluded':
      return t('record.notBuffered.excluded', locale, {
        channel: channelId,
        command: commandMention('voice autojoin include'),
      });
    case 'busyElsewhere':
      return t('record.notBuffered.busyElsewhere', locale, {
        other: gap.otherChannelId,
      });
    case 'readOnly':
      return t('record.notBuffered.readOnly', locale, { channel: channelId });
    case 'atLimit':
      return t('record.notBuffered.atLimit', locale, {
        max: env.MAX_CONCURRENT_VC_CONNECTIONS,
      });
    case 'noPermission':
      return t('record.notBuffered.noPermission', locale, {
        channel: channelId,
      });
    case 'notYetJoined':
      return t('record.notBuffered.notYetJoined', locale);
  }
}
