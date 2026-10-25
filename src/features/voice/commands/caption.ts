import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../../shared/types/index.js';
import { executeCaptionCommand } from '../application/index.js';

/**
 * Captions command - show what people say in a voice channel as text
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName('caption')
    .setDescription('Show what people say in your voice channel as text')
    .setDescriptionLocalizations({
      ja: 'VCでの発言を文字にしてチャットに表示（字幕）',
    })
    // Captions happen in a server's voice channel; nothing to do in DMs.
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start captions in your voice channel')
        .setDescriptionLocalizations({ ja: '参加中のVCで字幕を開始' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription('Stop captions')
        .setDescriptionLocalizations({ ja: '字幕を終了' })
    )
    .addSubcommand((sub) =>
      sub
        .setName('consent')
        .setDescription('Choose whether your voice may be captioned here')
        .setDescriptionLocalizations({
          ja: '自分の声を字幕にしてよいか、このサーバーでの設定を確認・変更',
        })
        .addBooleanOption((option) =>
          option
            .setName('allow')
            .setNameLocalizations({ ja: '許可' })
            .setDescription('Allow captions of your voice in this server')
            .setDescriptionLocalizations({
              ja: 'このサーバーで自分の声を字幕にすることを許可する',
            })
        )
    ) as SlashCommandBuilder,

  middleware: ['cooldown'],

  options: {
    cooldown: 2000,
  },

  help: {
    category: { en: 'Voice', ja: 'ボイス' },
  },

  execute: executeCaptionCommand,
};
