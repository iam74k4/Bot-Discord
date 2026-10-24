import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import {
  MAX_DICTIONARY_ENTRIES,
  ttsRepository,
} from '../repositories/ttsRepository.js';
import { ttsSessions } from '../tts/sessionManager.js';
import {
  buildMessageSpeech,
  isMarkedSilent,
  speakableName,
  type SpeechContext,
} from '../tts/textNormalizer.js';
import {
  clampSpeed,
  DEFAULT_SPEAKER_ID,
  getVoicevoxClient,
  voiceLabel,
} from '../tts/voicevoxClient.js';
import { announceBuffering } from './announce.js';

/**
 * `/tts` - read chat aloud in a voice channel with VOICEVOX.
 *
 * Open to every member: reading is for people who cannot or would rather not
 * speak, so gating it behind a permission would defeat it. What keeps it from
 * being a megaphone is that only members inside the voice channel are read,
 * and only they (or server managers) can stop or skip.
 */

export const MAX_WORD_LENGTH = 50;
export const MAX_READING_LENGTH = 100;
const DEFAULT_SPEED = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const AUTOCOMPLETE_LIMIT = 25;
const LIST_LIMIT = 40;

type GuildInteraction = ChatInputCommandInteraction<'cached'>;

async function replyError(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string
): Promise<void> {
  const embed = createErrorEmbed(title, description);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
    return;
  }
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function connectedChannelInGuild(guildId: string): string | undefined {
  for (const info of connectionManager.getAllConnections().values()) {
    if (info.guildId === guildId) return info.channelId;
  }
  return undefined;
}

function formatSpeed(speed: number): string {
  return String(Number(speed.toFixed(2)));
}

export async function executeTtsCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!interaction.inCachedGuild()) {
    await replyError(
      interaction,
      t('common.error', locale),
      t('common.guildOnly', locale)
    );
    return;
  }

  if (interaction.options.getSubcommandGroup(false) === 'dict') {
    await handleDictionary(interaction, locale);
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case 'start':
      await handleStart(interaction, locale);
      return;
    case 'stop':
      await handleStop(interaction, locale);
      return;
    case 'skip':
      await handleSkip(interaction, locale);
      return;
    default:
      await handleVoice(interaction, locale);
  }
}

async function handleStart(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const client = getVoicevoxClient();
  if (!client) {
    await replyError(
      interaction,
      t('tts.errors.notConfigured', locale),
      t('tts.errors.notConfiguredDesc', locale)
    );
    return;
  }

  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await replyError(
      interaction,
      t('tts.errors.notInVoice', locale),
      t('tts.errors.notInVoiceDesc', locale)
    );
    return;
  }

  const busyChannelId = connectedChannelInGuild(interaction.guildId);
  if (busyChannelId && busyChannelId !== voiceChannel.id) {
    await replyError(
      interaction,
      t('tts.errors.busyElsewhere', locale),
      t('tts.errors.busyElsewhereDesc', locale, { channel: busyChannelId })
    );
    return;
  }

  // Health check and joining can take longer than Discord's 3s reply window.
  await interaction.deferReply();

  if (!(await client.isAvailable())) {
    await replyError(
      interaction,
      t('tts.errors.engineDown', locale),
      t('tts.errors.engineDownDesc', locale)
    );
    return;
  }

  const joinedNow = !connectionManager.getConnection(voiceChannel.id);
  if (joinedNow) {
    // Reading never overrides a server's choice not to have audio buffered:
    // where auto-join is off, the bot joins deafened and keeps nothing.
    const receive = voiceSettingsRepository.mayAutoJoin(
      interaction.guildId,
      voiceChannel.id
    );
    const connection = await connectionManager.connect(
      interaction.guild,
      voiceChannel,
      { receive }
    );
    if (!connection) {
      await replyError(
        interaction,
        t('tts.errors.cannotJoin', locale),
        t('tts.errors.cannotJoinDesc', locale)
      );
      return;
    }
    if (receive) {
      await announceBuffering(voiceChannel);
    }
  }

  if (
    !(await connectionManager.waitUntilReady(
      voiceChannel.id,
      CONNECT_TIMEOUT_MS
    ))
  ) {
    // Without a session nothing would ever remove a join made for reading.
    if (joinedNow) {
      await connectionManager.disconnect(voiceChannel.id);
    }
    await replyError(
      interaction,
      t('tts.errors.cannotJoin', locale),
      t('tts.errors.cannotJoinDesc', locale)
    );
    return;
  }

  ttsSessions.start({
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    textChannelId: interaction.channelId,
    startedBy: interaction.user.id,
  });

  // Warm the voice list so the first `/tts voice` autocomplete is instant.
  void client.listVoices().catch(() => undefined);

  const me = interaction.guild.members.me;
  const canSpeak = me
    ? (voiceChannel.permissionsFor(me)?.has(PermissionFlagsBits.Speak) ?? false)
    : false;

  const description = t('tts.startedDesc', locale, {
    voice: voiceChannel.id,
  });

  await interaction.editReply({
    embeds: [
      createEmbed({
        title: t('tts.started', locale),
        description: canSpeak
          ? description
          : `${description}\n\n${t('tts.noSpeakPermission', locale)}`,
        color: COLORS.SUCCESS,
        fields: [
          {
            name: t('tts.howToTitle', locale),
            value: t('tts.howTo', locale, { voice: voiceChannel.id }),
          },
        ],
        footer: t('tts.credit', locale),
      }),
    ],
  });
}

/**
 * Stop and skip are limited to people who can hear the result - anyone in the
 * channel being read - plus server managers.
 */
async function requireSessionControl(
  interaction: GuildInteraction,
  locale: Locale
): Promise<string | null> {
  const session = ttsSessions.getForGuild(interaction.guildId);
  if (!session) {
    await replyError(
      interaction,
      t('tts.errors.notRunning', locale),
      t('tts.errors.notRunningDesc', locale)
    );
    return null;
  }

  const inChannel =
    interaction.member.voice.channelId === session.voiceChannelId;
  const isManager = interaction.memberPermissions.has(
    PermissionFlagsBits.ManageGuild
  );
  if (!inChannel && !isManager) {
    await replyError(
      interaction,
      t('tts.errors.notInSameVoice', locale),
      t('tts.errors.notInSameVoiceDesc', locale, {
        channel: session.voiceChannelId,
      })
    );
    return null;
  }

  return session.voiceChannelId;
}

async function handleStop(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const voiceChannelId = await requireSessionControl(interaction, locale);
  if (!voiceChannelId) return;

  ttsSessions.stop(voiceChannelId);

  // A connection made only to read has no reason to stay.
  if (connectionManager.getConnection(voiceChannelId)?.receiving === false) {
    await connectionManager.disconnect(voiceChannelId);
  }

  await interaction.reply({
    embeds: [
      createEmbed({
        title: t('tts.stopped', locale),
        description: t('tts.stoppedDesc', locale),
        color: COLORS.INFO,
      }),
    ],
  });
}

async function handleSkip(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const voiceChannelId = await requireSessionControl(interaction, locale);
  if (!voiceChannelId) return;

  const skipped = ttsSessions.skip(voiceChannelId);
  await interaction.reply({
    content: skipped
      ? t('tts.skipped', locale)
      : t('tts.nothingToSkip', locale),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleVoice(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const client = getVoicevoxClient();
  if (!client) {
    await replyError(
      interaction,
      t('tts.errors.notConfigured', locale),
      t('tts.errors.notConfiguredDesc', locale)
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let voices;
  try {
    voices = await client.listVoices();
  } catch {
    await replyError(
      interaction,
      t('tts.errors.engineDown', locale),
      t('tts.errors.engineDownDesc', locale)
    );
    return;
  }

  const userId = interaction.user.id;
  const current = ttsRepository.getUserSettings(userId) ?? {
    speakerId: DEFAULT_SPEAKER_ID,
    speed: DEFAULT_SPEED,
  };
  const speakerOption = interaction.options.getInteger('speaker');
  const speedOption = interaction.options.getNumber('speed');

  if (speakerOption === null && speedOption === null) {
    const voice = voices.find((v) => v.id === current.speakerId);
    await interaction.editReply({
      embeds: [
        createEmbed({
          title: t('tts.voice.currentTitle', locale),
          description: `${t('tts.voice.current', locale, {
            voice: voice ? voiceLabel(voice) : `#${current.speakerId}`,
            speed: formatSpeed(current.speed),
          })}\n\n${t('tts.voice.changeHint', locale)}`,
          color: COLORS.INFO,
          footer: voice
            ? t('tts.voice.credit', locale, { character: voice.character })
            : undefined,
        }),
      ],
    });
    return;
  }

  const speakerId = speakerOption ?? current.speakerId;
  const voice = voices.find((v) => v.id === speakerId);
  if (!voice) {
    await replyError(
      interaction,
      t('tts.voice.unknown', locale),
      t('tts.voice.unknownDesc', locale)
    );
    return;
  }

  const speed = clampSpeed(speedOption ?? current.speed);
  ttsRepository.setUserSettings(userId, { speakerId, speed });

  // Let them hear the new voice right away when they are being read.
  const session = ttsSessions.getForGuild(interaction.guildId);
  if (
    session &&
    interaction.member.voice.channelId === session.voiceChannelId
  ) {
    ttsSessions.enqueue(session.voiceChannelId, {
      authorId: userId,
      authorName: speakableName(
        interaction.member.displayName,
        speechContextFor(interaction.guild)
      ),
      text: t('tts.voice.preview', locale),
      speakerId,
      speed,
    });
  }

  await interaction.editReply({
    embeds: [
      createEmbed({
        title: t('tts.voice.setTitle', locale),
        description: t('tts.voice.current', locale, {
          voice: voiceLabel(voice),
          speed: formatSpeed(speed),
        }),
        color: COLORS.SUCCESS,
        footer: t('tts.voice.credit', locale, { character: voice.character }),
      }),
    ],
  });
}

async function handleDictionary(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const entries = ttsRepository.listDictionary(guildId);
    const shown = entries.slice(0, LIST_LIMIT);
    const lines = shown.map((entry) => `・${entry.word} → ${entry.reading}`);
    if (entries.length > shown.length) {
      lines.push(
        t('tts.dict.listMore', locale, {
          count: entries.length - shown.length,
        })
      );
    }
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('tts.dict.listTitle', locale),
          description:
            lines.length > 0
              ? lines.join('\n')
              : t('tts.dict.listEmpty', locale),
          color: COLORS.INFO,
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const word = interaction.options.getString('word', true).trim();

  if (subcommand === 'remove') {
    const entry = ttsRepository.getDictionaryEntry(guildId, word);
    if (!entry) {
      await replyError(
        interaction,
        t('common.error', locale),
        t('tts.dict.notFound', locale, { word })
      );
      return;
    }
    const isManager = interaction.memberPermissions.has(
      PermissionFlagsBits.ManageGuild
    );
    if (entry.createdBy !== interaction.user.id && !isManager) {
      await replyError(
        interaction,
        t('common.error', locale),
        t('tts.dict.notOwner', locale)
      );
      return;
    }
    ttsRepository.removeDictionaryEntry(guildId, word);
    await interaction.reply({
      embeds: [
        createEmbed({
          title: t('tts.dict.removedTitle', locale),
          description: t('tts.dict.removed', locale, { word }),
          color: COLORS.INFO,
        }),
      ],
    });
    return;
  }

  // add
  const reading = interaction.options.getString('reading', true).trim();
  if (
    word.length === 0 ||
    word.length > MAX_WORD_LENGTH ||
    reading.length === 0 ||
    reading.length > MAX_READING_LENGTH
  ) {
    await replyError(
      interaction,
      t('common.error', locale),
      t('tts.dict.invalid', locale, {
        wordMax: MAX_WORD_LENGTH,
        readingMax: MAX_READING_LENGTH,
      })
    );
    return;
  }

  const exists = ttsRepository.getDictionaryEntry(guildId, word) !== null;
  if (
    !exists &&
    ttsRepository.countDictionary(guildId) >= MAX_DICTIONARY_ENTRIES
  ) {
    await replyError(
      interaction,
      t('common.error', locale),
      t('tts.dict.full', locale, { max: MAX_DICTIONARY_ENTRIES })
    );
    return;
  }

  ttsRepository.upsertDictionaryEntry(
    guildId,
    word,
    reading,
    interaction.user.id
  );
  // Public on purpose: everyone in the server hears the result.
  await interaction.reply({
    embeds: [
      createEmbed({
        title: t('tts.dict.addedTitle', locale),
        description: exists
          ? t('tts.dict.updated', locale, { word, reading })
          : t('tts.dict.added', locale, { word, reading }),
        color: COLORS.SUCCESS,
      }),
    ],
  });
}

export async function autocompleteTts(
  interaction: AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value).trim().toLowerCase();

  if (focused.name === 'speaker') {
    const client = getVoicevoxClient();
    const voices = client ? await client.listVoices().catch(() => []) : [];
    await interaction.respond(
      voices
        .filter((voice) => voiceLabel(voice).toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((voice) => ({ name: voiceLabel(voice), value: voice.id }))
    );
    return;
  }

  if (focused.name === 'word' && interaction.guildId) {
    const entries = ttsRepository.listDictionary(interaction.guildId);
    await interaction.respond(
      entries
        .filter(
          (entry) =>
            entry.word.toLowerCase().includes(query) ||
            entry.reading.toLowerCase().includes(query)
        )
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((entry) => ({
          name: `${entry.word} → ${entry.reading}`.slice(0, 100),
          value: entry.word,
        }))
    );
    return;
  }

  await interaction.respond([]);
}

function speechContextFor(guild: Guild): SpeechContext {
  return {
    resolveUser: (id) =>
      guild.members.cache.get(id)?.displayName ??
      guild.client.users.cache.get(id)?.displayName,
    resolveRole: (id) => guild.roles.cache.get(id)?.name,
    resolveChannel: (id) => guild.channels.cache.get(id)?.name,
    dictionary: ttsRepository.listDictionary(guild.id),
  };
}

/**
 * Read a chat message aloud if a session covers its channel and its author
 * is in the voice channel being read.
 */
export async function handleTtsMessage(message: Message): Promise<void> {
  if (!message.inGuild()) return;
  if (message.author.bot || message.webhookId || message.system) return;

  const session = ttsSessions.findForTextChannel(
    message.guildId,
    message.channelId
  );
  if (!session) return;
  if (isMarkedSilent(message.content)) return;

  const member = message.member;
  if (!member || member.voice.channelId !== session.voiceChannelId) return;

  const context = speechContextFor(message.guild);
  const text = buildMessageSpeech(
    {
      content: message.content,
      attachments: [...message.attachments.values()].map((attachment) => ({
        isImage: attachment.contentType?.startsWith('image/') ?? false,
      })),
      stickerNames: [...message.stickers.values()].map(
        (sticker) => sticker.name
      ),
    },
    context
  );
  if (!text) return;

  const settings = ttsRepository.getUserSettings(message.author.id);
  ttsSessions.enqueue(session.voiceChannelId, {
    authorId: message.author.id,
    authorName: speakableName(member.displayName, context),
    text,
    speakerId: settings?.speakerId ?? DEFAULT_SPEAKER_ID,
    speed: settings?.speed ?? DEFAULT_SPEED,
  });
}
