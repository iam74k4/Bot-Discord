import type { VoiceConnection } from '@discordjs/voice';
import {
  type AutocompleteInteraction,
  ChannelType,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  type VoiceBasedChannel,
} from 'discord.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { mapDiscordLocale, t, type Locale } from '../../../locales/index.js';
import {
  resolveGuildLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { connectionManager } from '../recording/connectionManager.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import {
  MAX_DICTIONARY_ENTRIES,
  ttsRepository,
} from '../repositories/ttsRepository.js';
import { ttsSessions, type TtsSessionInfo } from '../tts/sessionManager.js';
import {
  buildMessageSpeech,
  isMarkedSilent,
  speakableName,
  type SpeechContext,
} from '../tts/textNormalizer.js';
import {
  clampSpeed,
  DEFAULT_CHARACTER,
  DEFAULT_SPEAKER_ID,
  getVoicevoxClient,
  voiceLabel,
  type VoicevoxClient,
  type VoicevoxVoice,
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
/** Room left in the 4,096-character embed description for the list. */
const LIST_MAX_CHARS = 3_900;
/** Discord rejects autocomplete choice names longer than this. */
const CHOICE_NAME_MAX = 100;
/**
 * How long to wait for the engine's voice list when the answer cannot wait
 * longer: autocomplete must answer within Discord's 3 s, and the start
 * message should not hang on a slow engine just to name the voices.
 */
const VOICE_LIST_WAIT_MS = 2_000;

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

/**
 * Dictionary text shown in a reply: as inline code, where Discord renders no
 * markdown, so no link or formatting can form from a word, a reading, or the
 * two together (escaping each value separately cannot stop "[text" in one
 * and "](url)" in the other from pairing up). Backticks become ˋ so the span
 * cannot be closed early.
 */
function asCode(text: string): string {
  return `\`${text.replaceAll('`', 'ˋ')}\``;
}

/**
 * An autocomplete choice name within Discord's limit, never ending on half a
 * surrogate pair.
 */
function choiceName(text: string): string {
  if (text.length <= CHOICE_NAME_MAX) return text;
  const code = text.charCodeAt(CHOICE_NAME_MAX - 1);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, CHOICE_NAME_MAX - (isHighSurrogate ? 1 : 0));
}

function humanMembers(channel: VoiceBasedChannel) {
  return channel.members.filter((member) => !member.user.bot);
}

/**
 * The engine's voice list without waiting on a slow engine: the last list
 * straight away when there is one (refreshed in the background once stale),
 * otherwise a fetch bounded to `waitMs`. A fetch that runs over keeps going
 * and fills the cache for next time; a failure yields an empty list.
 */
async function voicesWithin(
  client: VoicevoxClient,
  waitMs: number
): Promise<VoicevoxVoice[]> {
  const fetching = client.listVoices().catch((error: unknown) => {
    logger.debug(`Could not list VOICEVOX voices: ${getErrorMessage(error)}`);
    return [];
  });
  const cached = client.cachedVoices();
  if (cached) return cached;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<VoicevoxVoice[]>((resolve) => {
    timer = setTimeout(() => resolve([]), waitMs);
  });
  try {
    return await Promise.race([fetching, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The characters to credit when reading starts, as VOICEVOX and its
 * characters' terms require ("VOICEVOX:ずんだもん"): the default voice plus
 * the voices of everyone in the channel now. Falls back to the default
 * character when the engine cannot list its voices in time; anyone else is
 * then credited the first time they are read (see creditOnFirstUse).
 */
async function charactersToCredit(
  client: VoicevoxClient,
  voiceChannel: VoiceBasedChannel
): Promise<Set<string>> {
  const speakerIds = new Set([DEFAULT_SPEAKER_ID]);
  for (const member of humanMembers(voiceChannel).values()) {
    speakerIds.add(
      ttsRepository.getUserSettings(member.id)?.speakerId ?? DEFAULT_SPEAKER_ID
    );
  }

  const voices = await voicesWithin(client, VOICE_LIST_WAIT_MS);
  const characters = new Set([DEFAULT_CHARACTER]);
  for (const id of speakerIds) {
    const voice = voices.find((v) => v.id === id);
    if (voice) characters.add(voice.character);
  }
  return characters;
}

function formatCredits(characters: Iterable<string>, locale: Locale): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    [...characters].map((character) => `VOICEVOX:${character}`)
  );
}

/**
 * Credit a character the first time a session reads a line in it: members
 * who joined after the start message, or who changed voice from another
 * server, are heard in voices that message never named. Posted to the voice
 * channel's own chat, which every session reads. Best effort.
 */
function creditOnFirstUse(
  guild: Guild,
  voiceChannelId: string,
  speakerId: number
): void {
  const client = getVoicevoxClient();
  if (!client) return;
  const credit = (voices: VoicevoxVoice[]): void => {
    const character = voices.find((v) => v.id === speakerId)?.character;
    if (character && ttsSessions.creditCharacter(voiceChannelId, character)) {
      void postCredit(guild, voiceChannelId, character);
    }
  };
  const cached = client.cachedVoices();
  if (cached) {
    credit(cached);
    return;
  }
  void client.listVoices().then(credit, (error: unknown) => {
    logger.debug(`Could not list VOICEVOX voices: ${getErrorMessage(error)}`);
  });
}

async function postCredit(
  guild: Guild,
  channelId: string,
  character: string
): Promise<void> {
  try {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isSendable()) return;
    const locale = resolveGuildLocale(
      guild.id,
      mapDiscordLocale(guild.preferredLocale)
    );
    await channel.send({
      content: t('tts.voice.credit', locale, { character }),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.debug(
      `Could not post a voice credit in ${channelId}: ${getErrorMessage(error)}`
    );
  }
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

  // On a Stage the bot joins the audience, and Discord drops audio from the
  // audience: reading would report success and never be heard.
  if (voiceChannel.type === ChannelType.GuildStageVoice) {
    await replyError(
      interaction,
      t('tts.errors.stageUnsupported', locale),
      t('tts.errors.stageUnsupportedDesc', locale)
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
  // Fetch the voice list while checking and joining, so the credits in the
  // reply below usually have it even right after a restart.
  void client.listVoices().catch(() => undefined);

  if (!(await client.isAvailable())) {
    await replyError(
      interaction,
      t('tts.errors.engineDown', locale),
      t('tts.errors.engineDownDesc', locale)
    );
    return;
  }

  // The join this call made, if any; null when the bot was already there.
  let joined: VoiceConnection | null = null;
  if (!connectionManager.getConnection(voiceChannel.id)) {
    // Reading never overrides a server's choice not to have audio buffered:
    // where auto-join is off, the bot joins deafened and keeps nothing.
    const receive = voiceSettingsRepository.mayAutoJoin(
      interaction.guildId,
      voiceChannel.id
    );
    joined = await connectionManager.connect(interaction.guild, voiceChannel, {
      receive,
    });
    if (!joined) {
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
    // Only that join, though: if it died while we waited, whatever is in the
    // channel now (say, a fresh auto-join) is not ours to remove.
    if (joined) {
      await connectionManager.disconnect(voiceChannel.id, joined);
    }
    await replyError(
      interaction,
      t('tts.errors.cannotJoin', locale),
      t('tts.errors.cannotJoinDesc', locale)
    );
    return;
  }

  // Discord only delivers messages from channels the bot can view, while a
  // slash command works anywhere the member can use it. Reading History is
  // not needed: new messages arrive over the gateway, not from history.
  const canReadHere =
    interaction.channelId === voiceChannel.id ||
    interaction.appPermissions.has(PermissionFlagsBits.ViewChannel);

  const credited = await charactersToCredit(client, voiceChannel);
  ttsSessions.start({
    guildId: interaction.guildId,
    voiceChannelId: voiceChannel.id,
    // The voice chat is always read; add this channel only if it can be.
    textChannelId: canReadHere ? interaction.channelId : voiceChannel.id,
    startedBy: interaction.user.id,
    creditedCharacters: credited,
  });

  const me = interaction.guild.members.me;
  const canSpeak = me
    ? (voiceChannel.permissionsFor(me)?.has(PermissionFlagsBits.Speak) ?? false)
    : false;

  const description = [
    canReadHere
      ? t('tts.startedDesc', locale, { voice: voiceChannel.id })
      : t('tts.startedDescVoiceOnly', locale, { voice: voiceChannel.id }),
    ...(canReadHere ? [] : [t('tts.noViewPermission', locale)]),
    ...(canSpeak
      ? []
      : [t('tts.noSpeakPermission', locale, { voice: voiceChannel.id })]),
  ].join('\n\n');

  await interaction.editReply({
    embeds: [
      createEmbed({
        title: t('tts.started', locale),
        description,
        color: COLORS.SUCCESS,
        fields: [
          {
            name: t('tts.howToTitle', locale),
            value: t('tts.howTo', locale, { voice: voiceChannel.id }),
          },
        ],
        // Public on purpose: VOICEVOX requires listeners to see the credit.
        footer: t('tts.credit', locale, {
          credits: formatCredits(credited, locale),
        }),
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

  // A connection made only to read has no reason to stay - unless auto-join
  // was turned on while it sat there deafened, in which case the channel is
  // handed back to auto-join instead of being left unbuffered.
  if (connectionManager.getConnection(voiceChannelId)?.receiving === false) {
    if (!(await resumeAutoJoin(interaction.guild, voiceChannelId))) {
      await connectionManager.disconnect(voiceChannelId);
    }
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

/**
 * Turn a deafened reading connection into the listening one auto-join would
 * have made, if auto-join now covers the channel and people are in it.
 * In place: the bot does not leave, and members are told it is listening.
 */
async function resumeAutoJoin(
  guild: Guild,
  voiceChannelId: string
): Promise<boolean> {
  const channel = guild.channels.cache.get(voiceChannelId);
  if (
    !channel?.isVoiceBased() ||
    !voiceSettingsRepository.mayAutoJoin(guild.id, voiceChannelId) ||
    humanMembers(channel).size === 0 ||
    !connectionManager.enableReceive(voiceChannelId)
  ) {
    return false;
  }
  // Not awaited: a slow or rate-limited post must not hold up the reply past
  // Discord's 3 s window. announceBuffering catches its own errors.
  void announceBuffering(channel);
  return true;
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
    // This reply is private, but everyone hears the new voice: credit it
    // where they can see it - once per character per session, so switching
    // between styles of one character posts nothing.
    if (ttsSessions.creditCharacter(session.voiceChannelId, voice.character)) {
      void announceVoiceChange(interaction, session, voice, locale);
    }
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

/**
 * Post a voice change, with its credit, to a channel being read: the one
 * the command was used in if it is, else the voice channel's own chat. Best
 * effort - a missing permission must not fail the change itself.
 */
async function announceVoiceChange(
  interaction: GuildInteraction,
  session: TtsSessionInfo,
  voice: VoicevoxVoice,
  locale: Locale
): Promise<void> {
  const channelId = session.textChannelIds.has(interaction.channelId)
    ? interaction.channelId
    : session.voiceChannelId;
  try {
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel?.isSendable()) return;
    await channel.send({
      embeds: [
        createEmbed({
          description: t('tts.voice.changed', locale, {
            user: interaction.user.id,
            voice: voiceLabel(voice),
          }),
          color: COLORS.INFO,
          footer: t('tts.voice.credit', locale, { character: voice.character }),
        }),
      ],
    });
  } catch (error) {
    logger.debug(
      `Could not announce a voice change in ${channelId}: ${getErrorMessage(error)}`
    );
  }
}

async function handleDictionary(
  interaction: GuildInteraction,
  locale: Locale
): Promise<void> {
  const guildId = interaction.guildId;
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'list') {
    const entries = ttsRepository.listDictionary(guildId);
    // Up to LIST_LIMIT lines, stopping early rather than letting the embed
    // cut the description - and the "N more" line with it.
    const lines: string[] = [];
    let length = 0;
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      const line = `・${asCode(entry.word)} → ${asCode(entry.reading)}`;
      if (length + line.length + 1 > LIST_MAX_CHARS) break;
      lines.push(line);
      length += line.length + 1;
    }
    if (entries.length > lines.length) {
      lines.push(
        t('tts.dict.listMore', locale, {
          count: entries.length - lines.length,
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
        t('tts.dict.notFound', locale, { word: asCode(word) })
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
          description: t('tts.dict.removed', locale, { word: asCode(word) }),
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

  const existing = ttsRepository.getDictionaryEntry(guildId, word);
  const exists = existing !== null;
  // Changing a word is as restricted as removing it: otherwise anyone could
  // rewrite someone's reading (their name, say) and the rule would mean
  // nothing.
  if (
    existing &&
    existing.createdBy !== interaction.user.id &&
    !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    await replyError(
      interaction,
      t('common.error', locale),
      t('tts.dict.notOwner', locale)
    );
    return;
  }
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
        description: t(exists ? 'tts.dict.updated' : 'tts.dict.added', locale, {
          word: asCode(word),
          reading: asCode(reading),
        }),
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
    // Discord gives autocomplete 3 s; never spend them all on the engine.
    const voices = client ? await voicesWithin(client, VOICE_LIST_WAIT_MS) : [];
    await interaction.respond(
      voices
        .filter((voice) => voiceLabel(voice).toLowerCase().includes(query))
        .slice(0, AUTOCOMPLETE_LIMIT)
        .map((voice) => ({
          name: choiceName(voiceLabel(voice)),
          value: voice.id,
        }))
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
          name: choiceName(`${entry.word} → ${entry.reading}`),
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
  const speakerId = settings?.speakerId ?? DEFAULT_SPEAKER_ID;
  ttsSessions.enqueue(session.voiceChannelId, {
    authorId: message.author.id,
    authorName: speakableName(member.displayName, context),
    text,
    speakerId,
    speed: settings?.speed ?? DEFAULT_SPEED,
  });
  creditOnFirstUse(message.guild, session.voiceChannelId, speakerId);
}
