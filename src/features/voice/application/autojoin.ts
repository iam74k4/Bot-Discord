import {
  ChannelType,
  ChatInputCommandInteraction,
  type Guild,
  MessageFlags,
} from 'discord.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { mapDiscordLocale, t } from '../../../locales/index.js';
import {
  resolveGuildLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import type { VoiceConnectionInfo } from '../../../shared/types/voice.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { connectionManager } from '../recording/connectionManager.js';
import { ttsSessions } from '../tts/sessionManager.js';

/**
 * Stop the buffering in one channel. A deafened text-to-speech join keeps no
 * audio, so it is left alone and goes on reading. A listening connection is
 * dropped - the opt-out wins over reading through it - and if it was being
 * read through, the people there are told why and how to resume.
 * True when that ended a reading session.
 */
async function stopBuffering(
  guild: Guild,
  channelId: string,
  info: VoiceConnectionInfo
): Promise<boolean> {
  if (info.receiving === false) return false;
  const wasReading = ttsSessions.get(channelId) !== undefined;
  if (wasReading) {
    await noticeReadingStopped(guild, channelId);
  }
  await connectionManager.disconnect(channelId);
  return wasReading;
}

/** Best effort: a missing permission must not keep the bot buffering. */
async function noticeReadingStopped(
  guild: Guild,
  channelId: string
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
          title: t('tts.stopped', locale),
          description: t('tts.stoppedByOptOut', locale),
          color: COLORS.WARNING,
        }),
      ],
    });
  } catch (error) {
    logger.debug(
      `Could not tell ${channelId} reading stopped: ${getErrorMessage(error)}`
    );
  }
}

/**
 * `/voice autojoin` - control whether the bot joins voice channels and keeps
 * their audio. Gated by the command's ManageGuild middleware.
 */
export async function executeAutoJoinCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({
      embeds: [
        createErrorEmbed(
          t('common.error', locale),
          t('common.guildOnly', locale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();
  const minutes = Math.round(env.AUDIO_BUFFER_DURATION / 60);

  if (subcommand === 'enable' || subcommand === 'disable') {
    const enable = subcommand === 'enable';
    voiceSettingsRepository.setAutoJoinEnabled(guildId, enable);

    // Turning it off should stop the buffering already in progress, not just
    // prevent the next join.
    let readingStoppedIn: string | null = null;
    if (!enable) {
      for (const [channelId, info] of connectionManager.getAllConnections()) {
        if (
          info.guildId === guildId &&
          (await stopBuffering(interaction.guild, channelId, info))
        ) {
          readingStoppedIn = channelId;
        }
      }
    }

    const description = enable
      ? t('record.autojoin.enabled', locale, { minutes })
      : t('record.autojoin.disabled', locale);
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('record.autojoin.title', locale),
          description: readingStoppedIn
            ? `${description}\n\n${t('record.autojoin.readingStopped', locale, { channel: readingStoppedIn })}`
            : description,
          color: enable ? COLORS.SUCCESS : COLORS.WARNING,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    await interaction.reply({
      embeds: [
        createErrorEmbed(
          t('common.error', locale),
          t('record.errors.notInVoiceDesc', locale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'exclude') {
    voiceSettingsRepository.addExclusion(guildId, channel.id);

    const info = connectionManager.getConnection(channel.id);
    const readingStopped =
      info !== undefined &&
      (await stopBuffering(interaction.guild, channel.id, info));

    const description = t('record.autojoin.excluded', locale, {
      channel: channel.id,
    });
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('record.autojoin.title', locale),
          description: readingStopped
            ? `${description}\n\n${t('record.autojoin.readingStopped', locale, { channel: channel.id })}`
            : description,
          color: COLORS.WARNING,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const removed = voiceSettingsRepository.removeExclusion(guildId, channel.id);
  await interaction.reply({
    embeds: [
      removed
        ? createEmbed({
            title: t('record.autojoin.title', locale),
            description: t('record.autojoin.included', locale, {
              channel: channel.id,
            }),
            color: COLORS.SUCCESS,
          })
        : createErrorEmbed(
            t('common.error', locale),
            t('record.autojoin.notExcluded', locale, { channel: channel.id })
          ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}
