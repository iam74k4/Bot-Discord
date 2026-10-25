import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import { executeOwnerCommand } from '../application/owner.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('owner')
    .setDescription(
      'Bot operator tools for system status, backups, and broadcasts'
    )
    .setDescriptionLocalizations({
      ja: 'Bot運営者向けの状態確認・バックアップ・一斉通知',
    })
    // Hidden from everyone but server admins in servers; Discord ignores
    // default permissions in the bot's DM, where the owner can always use
    // it. Who may actually run it is checked against BOT_OWNER_IDS.
    .setDefaultMemberPermissions(0)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommandGroup((group) =>
      group
        .setName('system')
        .setDescription('Bot operator system tools')
        .setDescriptionLocalizations({
          ja: 'Bot運営者向けシステム機能',
        })
        .addSubcommand((sub) =>
          sub
            .setName('stats')
            .setDescription('View bot statistics')
            .setDescriptionLocalizations({
              ja: 'Bot統計を表示',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('db')
            .setDescription('View database statistics')
            .setDescriptionLocalizations({
              ja: 'データベース統計を表示',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('guilds')
            .setDescription('List servers the bot is in')
            .setDescriptionLocalizations({
              ja: 'Botが参加しているサーバー一覧',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('broadcast')
            .setDescription(
              'Post to every server that set an announcement channel (after confirmation)'
            )
            .setDescriptionLocalizations({
              ja: 'お知らせチャンネルを設定したサーバーへ一斉通知（確認あり）',
            })
            .addStringOption((opt) =>
              opt
                .setName('message')
                .setNameLocalizations({ ja: 'メッセージ' })
                .setDescription('Message to broadcast')
                .setDescriptionLocalizations({
                  ja: '送信するメッセージ',
                })
                .setRequired(true)
                .setMaxLength(2000)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('health')
            .setDescription('View system health status')
            .setDescriptionLocalizations({
              ja: 'システムヘルスステータスを表示',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('metrics')
            .setDescription('View bot usage metrics')
            .setDescriptionLocalizations({
              ja: 'Bot使用メトリクスを表示',
            })
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('backup')
        .setDescription('Backup management tools')
        .setDescriptionLocalizations({
          ja: 'バックアップ管理',
        })
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('List database backups')
            .setDescriptionLocalizations({
              ja: 'データベースバックアップ一覧',
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName('run')
            .setDescription('Run a manual database backup')
            .setDescriptionLocalizations({
              ja: '手動でデータベースバックアップを実行',
            })
        )
    ),

  help: {
    category: { en: 'Admin', ja: '管理者' },
    permission: 'owner',
  },

  async execute(interaction) {
    await executeOwnerCommand(interaction);
  },
};
