import {
  ChannelType,
  ChatInputCommandInteraction,
  type ColorResolvable,
  MessageFlags,
} from 'discord.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { releaseCooldown } from '../../../middleware/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { connectionManager } from '../recording/connectionManager.js';
import { keepsAudio } from '../recording/audioMode.js';
import type { ReconcileOutcome } from './reconcile.js';
import { auditVoiceSettingChange } from './settingsAudit.js';
import {
  disableAutoJoin,
  enableAutoJoin,
  excludeChannel,
  includeChannel,
} from './policy.js';

/** What a reconcile right after a change means for the admin. */
export function describeReconcile(
  outcome: ReconcileOutcome | undefined,
  locale: Locale
): string | null {
  switch (outcome?.status) {
    case 'joined':
      return t('record.autojoin.joinedNow', locale, {
        channel: outcome.channelId,
      });
    case 'none':
      return t('record.autojoin.waitingForMembers', locale);
    case 'already': {
      // A connection for reading or captions holds the guild's one voice
      // slot without keeping anything; "turned on" alone would suggest
      // otherwise.
      const connection = connectionManager.getConnection(outcome.channelId);
      return connection && !keepsAudio(connection)
        ? t('record.autojoin.alreadyReadOnly', locale, {
            channel: outcome.channelId,
          })
        : null;
    }
    default:
      return null;
  }
}

function answer(
  interaction: ChatInputCommandInteraction,
  locale: Locale,
  lines: Array<string | null>,
  color: ColorResolvable
) {
  return interaction.reply({
    embeds: [
      createEmbed({
        title: t('record.autojoin.title', locale),
        description: lines.filter(Boolean).join('\n\n'),
        color,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * The opt-outs stop auto-join and buffering, not reading: a deafened
 * text-to-speech join keeps nothing and stays. Only mention reading where
 * the bot can read at all.
 */
function withTtsNote(description: string, locale: Locale): string {
  return env.VOICEVOX_URL
    ? `${description} ${t('record.autojoin.ttsStillReads', locale)}`
    : description;
}

function readingStoppedLine(channelId: string, locale: Locale): string {
  return t('record.autojoin.readingStopped', locale, { channel: channelId });
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

  const guild = interaction.guild;
  const subcommand = interaction.options.getSubcommand();
  const minutes = Math.round(env.AUDIO_BUFFER_DURATION / 60);
  const audit = (change: Parameters<typeof auditVoiceSettingChange>[3]) =>
    auditVoiceSettingChange(
      interaction.client,
      guild,
      interaction.user.id,
      change,
      { command: `voice autojoin ${subcommand}` }
    );

  if (subcommand === 'enable') {
    const outcome = await enableAutoJoin(guild);
    audit({ kind: 'autoJoinEnabled' });
    await answer(
      interaction,
      locale,
      [
        t('record.autojoin.enabled', locale, { minutes }),
        describeReconcile(outcome, locale),
      ],
      COLORS.SUCCESS
    );
    return;
  }

  if (subcommand === 'disable') {
    // Turning it off stops the buffering already in progress, not just the
    // next join, and the reply waits until the bot has actually left.
    const { dropped, readingStoppedIn } = await disableAutoJoin(guild);
    audit({ kind: 'autoJoinDisabled' });
    await answer(
      interaction,
      locale,
      [
        withTtsNote(
          t('record.autojoin.disabled', locale, {
            command: commandMention('voice autojoin enable'),
          }),
          locale
        ),
        dropped > 0 ? t('record.autojoin.disabledDropped', locale) : null,
        ...readingStoppedIn.map((channelId) =>
          readingStoppedLine(channelId, locale)
        ),
      ],
      COLORS.SUCCESS
    );
    return;
  }

  const channel = interaction.options.getChannel('channel', true);
  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    releaseCooldown(interaction);
    await interaction.reply({
      embeds: [
        createErrorEmbed(
          t('common.error', locale),
          t('record.errors.notVoiceChannel', locale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (subcommand === 'exclude') {
    const { added, left, readingStopped } = await excludeChannel(
      guild,
      channel.id
    );
    if (added) audit({ kind: 'channelExcluded', channelId: channel.id });
    await answer(
      interaction,
      locale,
      [
        withTtsNote(
          added
            ? t('record.autojoin.excluded', locale, { channel: channel.id })
            : t('record.autojoin.alreadyExcluded', locale, {
                channel: channel.id,
              }),
          locale
        ),
        left
          ? t('record.autojoin.excludedLeft', locale, { channel: channel.id })
          : null,
        readingStopped ? readingStoppedLine(channel.id, locale) : null,
      ],
      added ? COLORS.SUCCESS : COLORS.INFO
    );
    return;
  }

  const { removed, outcome } = await includeChannel(guild, channel.id);
  if (!removed) {
    // Nothing to undo: say so plainly, it is not an error.
    await answer(
      interaction,
      locale,
      [t('record.autojoin.notExcluded', locale, { channel: channel.id })],
      COLORS.INFO
    );
    return;
  }

  audit({ kind: 'channelIncluded', channelId: channel.id });
  const autoJoinOn = voiceSettingsRepository.isAutoJoinEnabled(guild.id);
  await answer(
    interaction,
    locale,
    [
      t('record.autojoin.included', locale, { channel: channel.id }),
      autoJoinOn
        ? describeReconcile(outcome, locale)
        : t('record.autojoin.includedWhileOff', locale, {
            command: commandMention('voice autojoin enable'),
          }),
    ],
    autoJoinOn ? COLORS.SUCCESS : COLORS.WARNING
  );
}
