import { AutocompleteInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import {
  autocompleteHelpCommand,
  executeGeneralCommand,
} from '../application/index.js';

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('general')
    .setDescription('Start here for help, ping, and bot info')
    .setDescriptionLocalizations({
      ja: 'ヘルプ・Ping・Bot情報の入口',
    })
    .addSubcommand((sub) =>
      sub
        .setName('help')
        .setDescription('Browse commands and how to use them')
        .setDescriptionLocalizations({
          ja: 'コマンドの一覧と使い方を表示',
        })
        .addStringOption((option) =>
          option
            .setName('command')
            .setNameLocalizations({ ja: 'コマンド' })
            .setDescription('Type to search, e.g. poll or tts')
            .setDescriptionLocalizations({
              ja: '入力すると候補が出ます（例: 投票、読み上げ）',
            })
            // Every path and description is shorter; this also bounds
            // the search a typed query costs.
            .setMaxLength(100)
            .setAutocomplete(true)
        )
        .addBooleanOption((option) =>
          option
            .setName('public')
            .setNameLocalizations({ ja: 'みんなに表示' })
            .setDescription(
              'Show the help to everyone in the channel (default: only you)'
            )
            .setDescriptionLocalizations({
              ja: 'チャンネルの全員に見えるように表示します（既定: 自分だけ）',
            })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('ping')
        .setDescription('Check how fast the bot responds')
        .setDescriptionLocalizations({
          ja: 'Botの応答速度（レイテンシ）を確認',
        })
    )
    .addSubcommand((sub) =>
      sub
        .setName('about')
        .setDescription('What this bot does and how it handles voice')
        .setDescriptionLocalizations({
          ja: 'Botでできることと音声の扱いを表示',
        })
    ),

  middleware: ['cooldown'],

  options: {
    cooldown: 3000,
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    await autocompleteHelpCommand(interaction);
  },

  help: {
    category: { en: 'General', ja: '一般' },
    examples: {
      'general help': [
        {
          ja: '`/general help コマンド:読み上げ` 「読み上げ」に関係するコマンドを探す',
          en: '`/general help command:tts` find the text-to-speech commands',
        },
        {
          ja: '`/general help みんなに表示:True` 一覧をチャンネルの全員に見せる',
          en: '`/general help public:True` show the list to the whole channel',
        },
      ],
    },
  },

  async execute(interaction) {
    await executeGeneralCommand(interaction);
  },
};
