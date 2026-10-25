import {
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  type EmbedBuilder,
  type Guild,
} from 'discord.js';
import {
  createEmbed,
  createErrorEmbed,
  createWarningEmbed,
} from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { logAuditAction } from '../../../infrastructure/audit/index.js';
import { t } from '../../../locales/index.js';
import {
  LANGUAGE_AUTO,
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { createPermissionDeniedEmbed } from '../../../shared/utils/discord.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { showSettingsPanel } from './settingsPanel.js';
import {
  checkPostableChannel,
  describeChannelProblem,
} from './channelCheck.js';
import {
  ANNOUNCEMENT_CHANNEL_SETTING,
  AUDIT_CHANNEL_SETTING,
  saveChannelSetting,
  type ChannelSetting,
} from './channelSettings.js';
import { languageDisplayName } from './languages.js';
import { memberHasServerPermission } from './permissions.js';

async function replyPrivately(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder
): Promise<void> {
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleView(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  await showSettingsPanel(interaction, locale, 'overview');
}

/** How a channel subcommand words its reply. */
interface ChannelSubcommand {
  setting: ChannelSetting;
  nameKey: 'settings.audit.name' | 'settings.announcements.name';
  configuredKey:
    'settings.audit.configured' | 'settings.announcements.configured';
  disabledKey: 'settings.audit.disabled' | 'settings.announcements.disabled';
  /** Command to suggest next, by state. */
  nextStep: { set: string; cleared: string };
}

const AUDIT_SUBCOMMAND: ChannelSubcommand = {
  setting: AUDIT_CHANNEL_SETTING,
  nameKey: 'settings.audit.name',
  configuredKey: 'settings.audit.configured',
  disabledKey: 'settings.audit.disabled',
  nextStep: { set: 'admin settings logs', cleared: 'admin settings audit' },
};

const ANNOUNCEMENTS_SUBCOMMAND: ChannelSubcommand = {
  setting: ANNOUNCEMENT_CHANNEL_SETTING,
  nameKey: 'settings.announcements.name',
  configuredKey: 'settings.announcements.configured',
  disabledKey: 'settings.announcements.disabled',
  nextStep: {
    set: 'admin settings view',
    cleared: 'admin settings announcements',
  },
};

/**
 * Every "point this setting at a text channel" subcommand: an empty option
 * clears it, a set one is checked for postability first.
 */
async function handleChannelSetting(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  subcommand: ChannelSubcommand
): Promise<void> {
  const locale = resolveLocale(interaction);
  const channel = interaction.options.getChannel('channel');
  const change = {
    client: interaction.client,
    guild,
    userId: interaction.user.id,
  };

  if (!channel) {
    saveChannelSetting(subcommand.setting, { ...change, channelId: null });
    await replyPrivately(
      interaction,
      createEmbed({
        title: t(subcommand.nameKey, locale),
        description: `${t(subcommand.disabledKey, locale)}\n\n${t(
          'common.nextStep',
          locale
        )}: ${commandMention(subcommand.nextStep.cleared)}`,
        color: COLORS.WARNING,
      })
    );
    return;
  }

  const check = await checkPostableChannel(guild, channel.id);
  if (!check.ok) {
    await replyPrivately(
      interaction,
      createErrorEmbed(
        t('common.error', locale),
        describeChannelProblem(check, locale)
      )
    );
    return;
  }

  saveChannelSetting(subcommand.setting, { ...change, channelId: channel.id });
  await replyPrivately(
    interaction,
    createEmbed({
      title: t(subcommand.nameKey, locale),
      description: `${t(subcommand.configuredKey, locale, {
        channel: channel.id,
      })}\n\n${t('common.nextStep', locale)}: ${commandMention(
        subcommand.nextStep.set
      )}`,
      color: COLORS.SUCCESS,
    })
  );
}

async function handleLogs(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  await showSettingsPanel(interaction, locale, 'logs');
}

async function handleLanguage(
  interaction: ChatInputCommandInteraction,
  guild: Guild
): Promise<void> {
  const lang = interaction.options.getString('lang', true);
  const isAuto = lang === LANGUAGE_AUTO;

  // `auto` is stored as NULL so replies keep following each viewer's locale.
  guildSettingsRepository.setLanguage(guild.id, isAuto ? null : lang);

  // Resolved after the change, so the confirmation is already in the
  // language the server just chose (or the admin's own, on automatic).
  const locale = resolveLocale(interaction);
  const auditLocale = resolveBackgroundLocale(guild);

  void logAuditAction(
    interaction.client,
    guild.id,
    interaction.user.id,
    'SETTINGS_CHANGE',
    undefined,
    t('audit.details.language', auditLocale, {
      language: languageDisplayName(lang, auditLocale),
    })
  );

  await replyPrivately(
    interaction,
    createEmbed({
      title: t('settings.language.name', locale),
      description:
        t('settings.language.changed', locale, {
          language: languageDisplayName(lang, locale),
        }) +
        `\n\n${t('common.nextStep', locale)}: ${commandMention(
          'admin settings view'
        )}`,
      color: COLORS.SUCCESS,
    })
  );
}

export async function executeSettingsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const guild = interaction.guild;

  if (!guild) {
    await replyPrivately(
      interaction,
      createWarningEmbed(
        t('common.serverOnlyTitle', locale),
        t('common.guildOnly', locale)
      )
    );
    return;
  }

  if (
    !memberHasServerPermission(interaction, PermissionFlagsBits.ManageGuild)
  ) {
    await replyPrivately(
      interaction,
      createPermissionDeniedEmbed(PermissionFlagsBits.ManageGuild, locale)
    );
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'view':
      await handleView(interaction);
      break;
    case 'audit':
      await handleChannelSetting(interaction, guild, AUDIT_SUBCOMMAND);
      break;
    case 'announcements':
      await handleChannelSetting(interaction, guild, ANNOUNCEMENTS_SUBCOMMAND);
      break;
    case 'logs':
      await handleLogs(interaction);
      break;
    case 'language':
      await handleLanguage(interaction, guild);
      break;
  }
}
