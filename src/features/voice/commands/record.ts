import {
  ChannelType,
  InteractionContextType,
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
 * `/voice` - keep and save voice channel audio. Admin-only: hidden from
 * members by default (server admins can change that under Integrations),
 * and still checked by the permissions middleware on every run.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Keep and save voice channel audio (admins)')
    .setDescriptionLocalizations({
      ja: 'VCの音声の保持と録音（管理者向け）',
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('record')
        .setDescription(
          'Save the last few minutes of audio from your voice channel'
        )
        .setDescriptionLocalizations({
          ja: '今いるVCの直前の音声をさかのぼって保存（最大5分）',
        })
        .addStringOption((option) =>
          option
            .setName('duration')
            .setNameLocalizations({ ja: 'さかのぼる長さ' })
            .setDescription('How far back to save')
            .setDescriptionLocalizations({
              ja: 'どこまでさかのぼって保存するか',
            })
            .setRequired(true)
            .addChoices(
              {
                name: 'Last 30 seconds',
                name_localizations: { ja: '直前30秒' },
                value: '30s',
              },
              {
                name: 'Last minute',
                name_localizations: { ja: '直前1分' },
                value: '1m',
              },
              {
                name: 'Last 2 minutes',
                name_localizations: { ja: '直前2分' },
                value: '2m',
              },
              {
                name: 'Last 3 minutes',
                name_localizations: { ja: '直前3分' },
                value: '3m',
              },
              {
                name: 'Last 5 minutes (max)',
                name_localizations: { ja: '直前5分（最大）' },
                value: '5m',
              }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription(
          'Check whether your voice channel is kept, and change auto-join'
        )
        .setDescriptionLocalizations({
          ja: 'このVCの音声が保持されているかの確認と自動参加の設定',
        })
    )
    .addSubcommandGroup((group) =>
      group
        .setName('autojoin')
        .setDescription('Control which channels the bot keeps audio in')
        .setDescriptionLocalizations({
          ja: '音声を保持するVCの設定',
        })
        .addSubcommand((sub) =>
          sub
            .setName('enable')
            .setDescription('Let the bot join occupied voice channels')
            .setDescriptionLocalizations({
              ja: '人がいるVCへの自動参加をオンにする',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('disable')
            .setDescription('Stop the bot joining and keeping audio entirely')
            .setDescriptionLocalizations({
              ja: '自動参加と音声の保持をすべて止める',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('exclude')
            .setDescription('Keep the bot out of one voice channel')
            .setDescriptionLocalizations({
              ja: '特定のVCを自動参加の対象外にする',
            })
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
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
              ja: '対象外にしたVCを元に戻す',
            })
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
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
    // Recording is the expensive path; settings and status only need the
    // usual guard against double taps.
    cooldown: 3_000,
    cooldowns: {
      'voice record': 10_000,
    },
  },

  help: {
    category: { en: 'Voice', ja: 'ボイス' },
    // "録音" alone would otherwise rank the notification entry, whose
    // description says it is not recording, as high as this one.
    keywords: {
      'voice record': [{ ja: '録音', en: 'recording' }],
    },
    examples: {
      'voice record': [
        {
          ja: '`/voice record さかのぼる長さ:直前1分` 直前1分の音声をファイルで保存',
          en: '`/voice record duration:Last minute` saves the last minute of audio as a file',
        },
      ],
    },
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
