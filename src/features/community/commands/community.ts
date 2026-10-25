import {
  InteractionContextType,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import {
  autocompletePollToEnd,
  executePollCommand,
  executeRouletteCommand,
  MAX_ANSWER_LENGTH,
} from '../application/index.js';

/** Option slots on `/community poll create`; the form takes any number. */
const OPTION_SLOTS = 10;

function pollCreateSubcommand(
  subcommand: SlashCommandSubcommandBuilder
): SlashCommandSubcommandBuilder {
  subcommand
    .setName('create')
    .setDescription(
      'Create a poll (leave the options empty to type them in a form)'
    )
    .setDescriptionLocalizations({
      ja: '投票を作成（選択肢を省略すると入力フォームが開きます）',
    })
    .addStringOption((option) =>
      option
        .setName('question')
        .setNameLocalizations({ ja: '質問' })
        .setDescription('The poll question (up to 300 characters)')
        .setDescriptionLocalizations({ ja: '投票の質問（300文字まで）' })
        .setRequired(true)
        .setMaxLength(300)
    );

  // Optional, all of them: with fewer than two filled in, the command opens
  // a form that takes the options one per line, which is quicker on a phone.
  for (let slot = 1; slot <= OPTION_SLOTS; slot++) {
    subcommand.addStringOption((option) =>
      option
        .setName(`option${slot}`)
        .setNameLocalizations({ ja: `選択肢${slot}` })
        .setDescription(
          `Option ${slot} (up to ${MAX_ANSWER_LENGTH} characters)`
        )
        .setDescriptionLocalizations({
          ja: `選択肢${slot}（${MAX_ANSWER_LENGTH}文字まで）`,
        })
        .setMaxLength(MAX_ANSWER_LENGTH)
    );
  }

  return subcommand
    .addIntegerOption((option) =>
      option
        .setName('duration')
        .setNameLocalizations({ ja: '期間' })
        .setDescription('How long the poll stays open (default: 24 hours)')
        .setDescriptionLocalizations({
          ja: '投票を受け付ける期間（既定: 24時間）',
        })
        .addChoices(
          { name: '1 hour', name_localizations: { ja: '1時間' }, value: 1 },
          { name: '4 hours', name_localizations: { ja: '4時間' }, value: 4 },
          { name: '8 hours', name_localizations: { ja: '8時間' }, value: 8 },
          { name: '24 hours', name_localizations: { ja: '24時間' }, value: 24 },
          { name: '3 days', name_localizations: { ja: '3日' }, value: 72 },
          { name: '7 days', name_localizations: { ja: '7日' }, value: 168 }
        )
    )
    .addBooleanOption((option) =>
      option
        .setName('multi')
        .setNameLocalizations({ ja: '複数選択' })
        .setDescription('Let people pick more than one option')
        .setDescriptionLocalizations({
          ja: '1人で複数の選択肢に投票できるようにする',
        })
    );
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('community')
    .setDescription('Polls and VC roulette for quick community events')
    .setDescriptionLocalizations({
      ja: '投票とVCルーレットのコミュニティ機能',
    })
    // Polls and roulette both belong to a server; hide it from DMs.
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('poll')
        .setDescription('Create and manage polls')
        .setDescriptionLocalizations({
          ja: '投票の作成と管理',
        })
        .addSubcommand(pollCreateSubcommand)
        .addSubcommand((subcommand) =>
          subcommand
            .setName('end')
            .setDescription('Close one of your polls early')
            .setDescriptionLocalizations({
              ja: '自分の投票を早めに締め切る',
            })
            .addStringOption((option) =>
              option
                .setName('poll')
                .setNameLocalizations({ ja: '投票' })
                .setDescription(
                  'Which poll to end (default: your newest here, else in this server)'
                )
                .setDescriptionLocalizations({
                  ja: '締め切る投票（未指定ならこのチャンネルの最新、なければサーバー内の最新）',
                })
                .setAutocomplete(true)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('roulette')
        .setDescription('Pick members or split teams from your current VC')
        .setDescriptionLocalizations({
          ja: '参加中のVCからメンバー抽選やチーム分け',
        })
        .addSubcommand((subcommand) =>
          subcommand
            .setName('member')
            .setDescription('Pick one member of your voice channel at random')
            .setDescriptionLocalizations({
              ja: '参加中のVCからランダムに1人選ぶ',
            })
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('team')
            .setDescription(
              'Split the members of your voice channel into teams'
            )
            .setDescriptionLocalizations({
              ja: '参加中のVCのメンバーをチームに分ける',
            })
            .addIntegerOption((option) =>
              option
                .setName('count')
                .setNameLocalizations({ ja: 'チーム数' })
                .setDescription('Number of teams')
                .setDescriptionLocalizations({
                  ja: '作るチームの数',
                })
                .setRequired(true)
                .addChoices(
                  {
                    name: '2 teams',
                    name_localizations: { ja: '2チーム' },
                    value: 2,
                  },
                  {
                    name: '3 teams',
                    name_localizations: { ja: '3チーム' },
                    value: 3,
                  },
                  {
                    name: '4 teams',
                    name_localizations: { ja: '4チーム' },
                    value: 4,
                  },
                  {
                    name: '5 teams',
                    name_localizations: { ja: '5チーム' },
                    value: 5,
                  },
                  {
                    name: '6 teams',
                    name_localizations: { ja: '6チーム' },
                    value: 6,
                  }
                )
            )
        )
    ),

  middleware: ['cooldown'],

  options: {
    // Per path, so creating a poll never blocks ending it, and neither
    // touches roulette.
    cooldowns: {
      'community poll': 3_000,
      // Covers the ~3.6 s animation; another pick uses the result's buttons.
      'community roulette': 5_000,
    },
  },

  help: {
    category: { en: 'Community', ja: 'コミュニティ' },
    keywords: {
      'community roulette': [{ ja: 'ルーレット', en: 'roulette' }],
    },
    examples: {
      'community poll create': [
        {
          ja: '`/community poll create 質問:お昼どうする？` 選択肢を1行ずつ入力するフォームが開く',
          en: '`/community poll create question:Lunch?` opens a form to type the options one per line',
        },
        {
          ja: '`/community poll create 質問:お昼どうする？ 選択肢1:ラーメン 選択肢2:カレー` その場で投票を作成',
          en: '`/community poll create question:Lunch? option1:Ramen option2:Curry` posts the poll right away',
        },
      ],
      'community poll end': [
        {
          ja: '`/community poll end` このチャンネルで自分が最後に作った投票を締め切る（なければサーバー内で最後に作った投票）',
          en: '`/community poll end` closes your newest poll in this channel, or else your newest in the server',
        },
      ],
      'community roulette team': [
        {
          ja: '`/community roulette team チーム数:2` VCのメンバーを2チームに分ける',
          en: '`/community roulette team count:2` splits your VC into two teams',
        },
      ],
    },
  },

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(true);
    if (group === 'poll') {
      await executePollCommand(interaction);
      return;
    }
    await executeRouletteCommand(interaction);
  },

  async autocomplete(interaction) {
    // `poll` on `/community poll end` is the only autocomplete option.
    await autocompletePollToEnd(interaction);
  },
};
