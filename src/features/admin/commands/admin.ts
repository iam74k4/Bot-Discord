import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import {
  executeRoleCommand,
  executeSettingsCommand,
} from '../application/index.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Server settings plus role tools for moderators')
    .setDescriptionLocalizations({
      ja: 'サーバー設定とロール操作の管理者コマンド',
    })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    // Every subcommand acts on a server, so it is not offered in DMs.
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('settings')
        .setDescription('View and change this server configuration')
        .setDescriptionLocalizations({
          ja: 'このサーバーの設定を確認・変更',
        })
        .addSubcommand((sub) =>
          sub
            .setName('view')
            .setDescription('View current settings')
            .setDescriptionLocalizations({
              ja: '現在の設定を表示',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('audit')
            .setDescription('Set audit log channel')
            .setDescriptionLocalizations({
              ja: '監査ログチャンネルを設定',
            })
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
                .setDescription(
                  'Channel for audit logs (leave empty to disable)'
                )
                .setDescriptionLocalizations({
                  ja: '監査ログを送信するチャンネル（空で無効化）',
                })
                .addChannelTypes(ChannelType.GuildText)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('announcements')
            .setDescription('Set the channel for bot operator announcements')
            .setDescriptionLocalizations({
              ja: 'Bot運営者からのお知らせを受け取るチャンネルを設定',
            })
            .addChannelOption((opt) =>
              opt
                .setName('channel')
                .setNameLocalizations({ ja: 'チャンネル' })
                .setDescription(
                  'Channel for announcements (leave empty to opt out)'
                )
                .setDescriptionLocalizations({
                  ja: 'お知らせを受け取るチャンネル（空で受け取らない）',
                })
                .addChannelTypes(ChannelType.GuildText)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('logs')
            .setDescription('View recent audit logs')
            .setDescriptionLocalizations({
              ja: '最近の監査ログを表示',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('language')
            .setDescription('Set server default language')
            .setDescriptionLocalizations({
              ja: 'サーバーのデフォルト言語を設定',
            })
            .addStringOption((opt) =>
              opt
                .setName('lang')
                .setNameLocalizations({ ja: '言語' })
                .setDescription(
                  "Bot language (automatic: replies follow each user's Discord)"
                )
                .setDescriptionLocalizations({
                  ja: 'Botの表示言語（自動: 返信を各ユーザーのDiscordの言語に合わせる）',
                })
                .setRequired(true)
                .addChoices(
                  { name: 'English', value: 'en' },
                  { name: '日本語', value: 'ja' },
                  {
                    name: 'Automatic (follow each user)',
                    name_localizations: { ja: '自動（ユーザーに合わせる）' },
                    value: 'auto',
                  }
                )
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('role')
        .setDescription('Add or remove member roles')
        .setDescriptionLocalizations({
          ja: 'メンバーへのロール付与・解除',
        })
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Add a role to a member')
            .setDescriptionLocalizations({
              ja: 'メンバーにロールを付与',
            })
            .addUserOption((opt) =>
              opt
                .setName('user')
                .setNameLocalizations({ ja: 'メンバー' })
                .setDescription('Member to add the role to')
                .setDescriptionLocalizations({
                  ja: 'ロールを付与するメンバー',
                })
                .setRequired(true)
            )
            .addRoleOption((opt) =>
              opt
                .setName('role')
                .setNameLocalizations({ ja: 'ロール' })
                .setDescription('Role to add')
                .setDescriptionLocalizations({
                  ja: '付与するロール',
                })
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove a role from a member')
            .setDescriptionLocalizations({
              ja: 'メンバーからロールを外す',
            })
            .addUserOption((opt) =>
              opt
                .setName('user')
                .setNameLocalizations({ ja: 'メンバー' })
                .setDescription('Member to remove the role from')
                .setDescriptionLocalizations({
                  ja: 'ロールを外すメンバー',
                })
                .setRequired(true)
            )
            .addRoleOption((opt) =>
              opt
                .setName('role')
                .setNameLocalizations({ ja: 'ロール' })
                .setDescription('Role to remove')
                .setDescriptionLocalizations({
                  ja: '外すロール',
                })
                .setRequired(true)
            )
        )
    ),

  help: {
    category: { en: 'Admin', ja: '管理者' },
    permission: ['manageGuild', 'manageRoles'],
    // Each group checks its own permission, so help lists each group only to
    // the members that group serves. Discord still shows /admin only to
    // Manage Server holders (the default above); a moderator with Manage
    // Roles alone gets `/admin role` once a server admin allows them the
    // command under Server Settings → Integrations.
    subcommandPermissions: {
      'admin settings': 'manageGuild',
      'admin role': 'manageRoles',
    },
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);

    if (group === 'settings') {
      await executeSettingsCommand(interaction);
      return;
    }

    if (group === 'role') {
      await executeRoleCommand(interaction);
      return;
    }
  },
};
