import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import { autocompleteTts, executeTtsCommand } from '../application/index.js';
import { MAX_SPEED, MIN_SPEED } from '../tts/voicevoxClient.js';
import { MAX_READING_LENGTH, MAX_WORD_LENGTH } from '../application/tts.js';

/**
 * Text-to-speech command - read chat aloud in a voice channel
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('Read chat aloud in your voice channel (VOICEVOX)')
    .setDescriptionLocalizations({
      ja: 'チャットをVCで読み上げ（VOICEVOX）',
    })
    // Reading happens in a server's voice channel; there is nothing to do in DMs.
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start reading this channel in your voice channel')
        .setDescriptionLocalizations({
          ja: '参加中のVCでこのチャンネルの読み上げを開始',
        })
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop reading')
        .setDescriptionLocalizations({ ja: '読み上げを終了' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('skip')
        .setDescription('Skip the message being read')
        .setDescriptionLocalizations({ ja: '読み上げ中の発言を飛ばす' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('voice')
        .setDescription('Show or change your voice and speed')
        .setDescriptionLocalizations({ ja: '自分の声と速さを確認・変更' })
        .addIntegerOption((option) =>
          option
            .setName('speaker')
            .setDescription('Voice (type to search)')
            .setDescriptionLocalizations({ ja: '声（入力して検索）' })
            .setAutocomplete(true)
        )
        .addNumberOption((option) =>
          option
            .setName('speed')
            .setDescription(`Speed (${MIN_SPEED}–${MAX_SPEED}, default 1.0)`)
            .setDescriptionLocalizations({
              ja: `速さ（${MIN_SPEED}〜${MAX_SPEED}、標準は1.0）`,
            })
            .setMinValue(MIN_SPEED)
            .setMaxValue(MAX_SPEED)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName('dict')
        .setDescription('Teach the bot how to read words in this server')
        .setDescriptionLocalizations({ ja: 'このサーバーの読み方辞書' })
        .addSubcommand((sub) =>
          sub
            .setName('add')
            .setDescription('Add or update a reading')
            .setDescriptionLocalizations({ ja: '読み方を登録・更新' })
            .addStringOption((option) =>
              option
                .setName('word')
                .setDescription('Word as written (e.g. w)')
                .setDescriptionLocalizations({ ja: '書き方（例: w）' })
                .setMaxLength(MAX_WORD_LENGTH)
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName('reading')
                .setDescription('How to read it (e.g. わら)')
                .setDescriptionLocalizations({ ja: '読み方（例: わら）' })
                .setMaxLength(MAX_READING_LENGTH)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Remove a reading')
            .setDescriptionLocalizations({ ja: '読み方を削除' })
            .addStringOption((option) =>
              option
                .setName('word')
                .setDescription('Word to remove (type to search)')
                .setDescriptionLocalizations({
                  ja: '削除する単語（入力して検索）',
                })
                .setAutocomplete(true)
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('Show the dictionary')
            .setDescriptionLocalizations({ ja: '辞書の一覧を表示' })
        )
    ) as SlashCommandBuilder,

  middleware: ['cooldown'],

  options: {
    cooldown: 2000,
  },

  help: {
    category: { en: 'Voice', ja: 'ボイス' },
  },

  execute: executeTtsCommand,
  autocomplete: autocompleteTts,
};
