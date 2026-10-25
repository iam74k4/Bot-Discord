import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import {
  executeAutoJoinCommand,
  executeRecordCommand,
  executeStatusCommand,
} from '../application/index.js';

/**
 * Record command - record past audio from voice channel
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('VC recording and recorder status')
    .setDescriptionLocalizations({
      ja: 'VC録音とレコーダー状態確認',
    })
    .addSubcommand((sub) =>
      sub
        .setName('record')
        .setDescription('Record recent audio from your current voice channel')
        .setDescriptionLocalizations({
          ja: '現在参加中のVCの少し前の音声を録音',
        })
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('Recording duration')
            .setDescriptionLocalizations({
              ja: '録音時間',
            })
            .setRequired(true)
            .addChoices(
              {
                name: '30 seconds',
                name_localizations: { ja: '30秒' },
                value: '30s',
              },
              {
                name: '1 minute',
                name_localizations: { ja: '1分' },
                value: '1m',
              },
              {
                name: '2 minutes',
                name_localizations: { ja: '2分' },
                value: '2m',
              },
              {
                name: '3 minutes',
                name_localizations: { ja: '3分' },
                value: '3m',
              },
              {
                name: '5 minutes (max)',
                name_localizations: { ja: '5分（最大）' },
                value: '5m',
              }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show recorder capacity and active connections')
        .setDescriptionLocalizations({
          ja: '録音の接続数と上限を表示',
        })
    )
    .addSubcommandGroup((group) =>
      group
        .setName('autojoin')
        .setDescription('Control which channels the bot buffers audio in')
        .setDescriptionLocalizations({
          ja: '音声を保持するチャンネルの設定',
        })
        .addSubcommand((sub) =>
          sub
            .setName('enable')
            .setDescription('Let the bot join occupied voice channels')
            .setDescriptionLocalizations({
              ja: '人がいるVCへの自動参加を有効化',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('disable')
            .setDescription('Stop auto-joining and audio buffering')
            .setDescriptionLocalizations({
              ja: '自動参加と音声保持を停止',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('exclude')
            .setDescription(
              'Exclude one voice channel from auto-join and buffering'
            )
            .setDescriptionLocalizations({
              ja: '特定のVCを対象外にする',
            })
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Voice channel to exclude')
                .setDescriptionLocalizations({ ja: '対象外にするVC' })
                .addChannelTypes(
                  ChannelType.GuildVoice,
                  ChannelType.GuildStageVoice
                )
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('include')
            .setDescription('Remove a voice channel from the exclusion list')
            .setDescriptionLocalizations({
              ja: '対象外の設定を解除',
            })
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('Voice channel to include again')
                .setDescriptionLocalizations({ ja: '対象に戻すVC' })
                .addChannelTypes(
                  ChannelType.GuildVoice,
                  ChannelType.GuildStageVoice
                )
                .setRequired(true)
            )
        )
    ) as SlashCommandBuilder,

  middleware: ['permissions', 'cooldown'],

  options: {
    permissions: [PermissionFlagsBits.ManageGuild],
    cooldown: 10000, // 10 seconds cooldown
  },

  help: {
    category: { en: 'Voice', ja: 'ボイス' },
  },

  async execute(interaction) {
    if (interaction.options.getSubcommandGroup(false) === 'autojoin') {
      await executeAutoJoinCommand(interaction);
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'record') {
      await executeRecordCommand(interaction);
      return;
    }

    await executeStatusCommand(interaction);
  },
};
