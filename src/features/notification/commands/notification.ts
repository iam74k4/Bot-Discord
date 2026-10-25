import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import {
  handleVoiceSet,
  handleVoiceRemove,
  handleWelcomeSet,
  handleWelcomeRemove,
  handleStatus,
  handleStats,
} from '../application/index.js';
import {
  createPermissionDeniedEmbed,
  interactionHasGuildPermission,
} from '../../../shared/utils/discord.js';
import { resolveLocale } from '../../../locales/guildLocale.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('notification')
    .setDescription('Notification settings and VC time stats')
    .setDescriptionLocalizations({ ja: '通知設定・VC統計' })
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('voice')
        .setDescription('VC join/leave notifications, not recordings')
        .setDescriptionLocalizations({
          ja: 'VC入退室の通知設定（録音ではありません）',
        })
        .addSubcommand((sub) =>
          sub
            .setName('set')
            .setDescription('Set the notification channel for VC events')
            .setDescriptionLocalizations({
              ja: 'VC入退室通知チャンネルを設定',
            })
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
                .setDescription('Text channel for notifications')
                .setDescriptionLocalizations({ ja: '通知先テキストチャンネル' })
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('disable')
            .setDescription('Disable VC notifications')
            .setDescriptionLocalizations({ ja: 'VC入退室通知を無効化' })
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('welcome')
        .setDescription('New member join announcements')
        .setDescriptionLocalizations({ ja: 'メンバー参加通知' })
        .addSubcommand((sub) =>
          sub
            .setName('set')
            .setDescription('Set the notification channel for new members')
            .setDescriptionLocalizations({
              ja: 'メンバー参加通知チャンネルを設定',
            })
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
                .setDescription('Text channel for notifications')
                .setDescriptionLocalizations({ ja: '通知先テキストチャンネル' })
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('disable')
            .setDescription('Disable member join notifications')
            .setDescriptionLocalizations({ ja: 'メンバー参加通知を無効化' })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show the current notification settings panel')
        .setDescriptionLocalizations({ ja: '現在の通知設定パネルを表示' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('stats')
        .setDescription('Show your own VC time statistics')
        .setDescriptionLocalizations({ ja: '自分のVC滞在時間統計を表示' })
        .addStringOption((opt) =>
          opt
            .setName('period')
            .setNameLocalizations({ ja: '期間' })
            .setDescription('Period (all time if omitted)')
            .setDescriptionLocalizations({
              ja: '集計する期間（未指定なら全期間）',
            })
            .addChoices(
              {
                name: 'Today',
                name_localizations: { ja: '今日' },
                value: 'today',
              },
              {
                name: 'Last 7 days',
                name_localizations: { ja: '過去7日間' },
                value: 'week',
              },
              {
                name: 'Last 30 days',
                name_localizations: { ja: '過去30日間' },
                value: 'month',
              },
              {
                name: 'All time',
                name_localizations: { ja: '全期間' },
                value: 'all',
              }
            )
        )
    ) as SlashCommandBuilder,

  help: {
    category: { en: 'Notification', ja: '通知' },
    permission: 'everyone',
    // The settings subcommands check Manage Server themselves; the builder
    // cannot declare that, so help mirrors it here.
    subcommandPermissions: {
      'notification voice': 'manageGuild',
      'notification welcome': 'manageGuild',
      'notification status': 'manageGuild',
    },
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'stats') return handleStats(interaction);

    if (
      !interactionHasGuildPermission(
        interaction,
        PermissionFlagsBits.ManageGuild
      )
    ) {
      await interaction.reply({
        embeds: [
          createPermissionDeniedEmbed(
            PermissionFlagsBits.ManageGuild,
            resolveLocale(interaction)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (group === 'voice') {
      if (subcommand === 'set') return handleVoiceSet(interaction);
      if (subcommand === 'disable') return handleVoiceRemove(interaction);
    }

    if (group === 'welcome') {
      if (subcommand === 'set') return handleWelcomeSet(interaction);
      if (subcommand === 'disable') return handleWelcomeRemove(interaction);
    }

    if (subcommand === 'status') return handleStatus(interaction);
  },
};
