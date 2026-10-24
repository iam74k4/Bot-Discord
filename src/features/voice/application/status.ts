import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { t } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';

/** A text-to-speech-only join keeps no audio, so it does not count. */
function isBuffering(channelId: string): boolean {
  const connection = connectionManager.getConnection(channelId);
  return connection !== undefined && connection.receiving !== false;
}

/**
 * `/voice status` - recorder capacity plus whether this channel is buffered.
 */
export async function executeStatusCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const activeConnections = connectionManager.getConnectionCount();
  const guildId = interaction.guildId;

  const autoJoinEnabled = guildId
    ? voiceSettingsRepository.isAutoJoinEnabled(guildId)
    : false;
  const exclusions = guildId
    ? voiceSettingsRepository.listExclusions(guildId)
    : [];

  // Whether the caller's own channel is being buffered right now is the
  // question people actually have when they run this.
  const memberChannelId =
    interaction.member && 'voice' in interaction.member
      ? (interaction.member.voice.channelId ?? null)
      : null;

  let currentChannelState: string;
  if (!memberChannelId || !guildId) {
    currentChannelState = t('record.autojoin.currentChannelNone', locale);
  } else if (
    voiceSettingsRepository.isChannelExcluded(guildId, memberChannelId)
  ) {
    currentChannelState = t('record.autojoin.currentChannelExcluded', locale);
  } else if (isBuffering(memberChannelId)) {
    currentChannelState = t('record.autojoin.currentChannelBuffered', locale);
  } else {
    currentChannelState = t('record.autojoin.currentChannelNone', locale);
  }

  const embed = createEmbed({
    title: locale === 'ja' ? 'ボイス機能の状態' : 'Voice subsystem status',
    description: `${t('record.statusHint', locale)}\n\n${currentChannelState}`,
    color: COLORS.INFO,
    fields: [
      {
        name: locale === 'ja' ? 'アクティブ接続数' : 'Active connections',
        value: String(activeConnections),
        inline: true,
      },
      {
        name: locale === 'ja' ? '接続上限' : 'Connection limit',
        value: String(env.MAX_CONCURRENT_VC_CONNECTIONS),
        inline: true,
      },
      {
        name: t('record.bufferWindow', locale),
        value: `${Math.round(env.AUDIO_BUFFER_DURATION / 60)} min`,
        inline: true,
      },
      {
        name: t('record.autojoin.title', locale),
        value: autoJoinEnabled
          ? t('record.autojoin.statusEnabled', locale)
          : t('record.autojoin.statusDisabled', locale),
        inline: true,
      },
      {
        name: t('record.autojoin.exclusionCount', locale),
        value: String(exclusions.length),
        inline: true,
      },
    ],
  });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
