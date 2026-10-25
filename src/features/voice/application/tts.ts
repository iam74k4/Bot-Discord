import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  type VoiceBasedChannel,
} from 'discord.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import {
  createEmbed,
  createErrorEmbed,
  createInfoEmbed,
  createWarningEmbed,
} from '../../../shared/utils/embed.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { formatPermissionNames } from '../../../shared/utils/discord.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { releaseCooldown } from '../../../middleware/index.js';
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
  type VoicevoxVoice,
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
/**
 * Autocomplete must answer within Discord's 3 s; with nothing cached, wait
 * this long for the engine and then offer nothing rather than fail.
 */
export const AUTOCOMPLETE_WAIT_MS = 2_000;
const LIST_LIMIT = 40;

type GuildInteraction = ChatInputCommandInteraction<'cached'>;
type Severity = 'error' | 'warning' | 'info';

const EMBED_FOR: Record<
  Severity,
  (title: string, description: string) => ReturnType<typeof createErrorEmbed>
> = {
  error: createErrorEmbed,
  warning: createWarningEmbed,
  info: createInfoEmbed,
};

/** A private answer in place of the result: before or after deferring. */
async function replyNotice(
  interaction: ChatInputCommandInteraction,
  severity: Severity,
  title: string,
  description: string
): Promise<void> {
  const embed = EMBED_FOR[severity](title, description);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed] });
    return;
  }
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/** Something went wrong on our side (engine, joining). */
function replyError(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string
): Promise<void> {
  return replyNotice(interaction, 'error', title, description);
}

/**
 * The request was turned down before any work, for a reason the member can
 * fix (join the channel, pick another word): the cooldown it started is
 * given back so the retry goes through at once.
 */
function refuse(
  interaction: ChatInputCommandInteraction,
  severity: Exclude<Severity, 'error'>,
  title: string,
  description: string
): Promise<void> {
  releaseCooldown(interaction);
  return replyNotice(interaction, severity, title, description);
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

/** The voices members of a channel will be read with, default included. */
function speakersIn(channel: VoiceBasedChannel): number[] {
  const speakers = new Set<number>([DEFAULT_SPEAKER_ID]);
  for (const member of channel.members?.values() ?? []) {
    if (member.user?.bot) continue;
    const settings = ttsRepository.getUserSettings(member.id);
    if (settings) speakers.add(settings.speakerId);
  }
  return [...speakers];
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
    await refuse(
      interaction,
      'warning',
      t('tts.errors.notInVoice', locale),
      t('tts.errors.notInVoiceDesc', locale, {
        command: commandMention('tts start'),
      })
    );
    return;
  }

  const busyChannelId = connectedChannelInGuild(interaction.guildId);
  if (busyChannelId && busyChannelId !== voiceChannel.id) {
    await refuse(
      interaction,
      'warning',
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

  // Load the voices of everyone here, so nobody's first line waits a second
  // for its model, and warm the voice list for `/tts voice` autocomplete.
  // Neither is awaited: the reply does not wait on the engine.
  ttsSessions.warmUp(speakersIn(voiceChannel));
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
            value: t('tts.howTo', locale, {
              voice: voiceChannel.id,
              voiceCommand: commandMention('tts voice'),
              dictCommand: commandMention('tts dict add'),
              skipCommand: commandMention('tts skip'),
              stopCommand: commandMention('tts stop'),
            }),
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
    await refuse(
      interaction,
      'info',
      t('tts.errors.notRunning', locale),
      t('tts.errors.notRunningDesc', locale, {
        command: commandMention('tts start'),
      })
    );
    return null;
  }

  const inChannel =
    interaction.member.voice.channelId === session.voiceChannelId;
  const isManager = interaction.memberPermissions.has(
    PermissionFlagsBits.ManageGuild
  );
  if (!inChannel && !isManager) {
    await refuse(
      interaction,
      'warning',
      t('tts.errors.notInSameVoice', locale),
      t('tts.errors.notInSameVoiceDesc', locale, {
        channel: session.voiceChannelId,
        permission: formatPermissionNames(
          PermissionFlagsBits.ManageGuild,
          locale
        ),
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
        description: t('tts.stoppedDesc', locale, {
          command: commandMention('tts start'),
        }),
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
          })}\n\n${t('tts.voice.changeHint', locale, {
            command: commandMention('tts voice'),
          })}`,
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
    await refuse(
      interaction,
      'warning',
      t('tts.voice.unknown', locale),
      t('tts.voice.unknownDesc', locale)
    );
    return;
  }

  const speed = clampSpeed(speedOption ?? current.speed);
  ttsRepository.setUserSettings(userId, { speakerId, speed });

  const session = ttsSessions.getForGuild(interaction.guildId);
  if (
    session &&
    interaction.member.voice.channelId === session.voiceChannelId
  ) {
    // Let them hear the new voice right away when they are being read. The
    // preview is its own line, never folded into one of their messages.
    ttsSessions.enqueue(session.voiceChannelId, {
      authorId: userId,
      authorName: speakableName(
        interaction.member.displayName,
        speechContextFor(interaction.guild)
      ),
      text: t('tts.voice.preview', locale),
      speakerId,
      speed,
      mergeable: false,
    });
  } else if (session) {
    // Reading is running here, so this voice will be needed soon.
    ttsSessions.warmUp([speakerId]);
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
              : t('tts.dict.listEmpty', locale, {
                  command: commandMention('tts dict add'),
                }),
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
      await refuse(
        interaction,
        'warning',
        t('tts.dict.notFoundTitle', locale),
        t('tts.dict.notFound', locale, { word })
      );
      return;
    }
    const isManager = interaction.memberPermissions.has(
      PermissionFlagsBits.ManageGuild
    );
    if (entry.createdBy !== interaction.user.id && !isManager) {
      await refuse(
        interaction,
        'warning',
        t('tts.dict.notOwnerTitle', locale),
        t('tts.dict.notOwner', locale, {
          permission: formatPermissionNames(
            PermissionFlagsBits.ManageGuild,
            locale
          ),
        })
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
    await refuse(
      interaction,
      'warning',
      t('tts.dict.invalidTitle', locale),
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
    await refuse(
      interaction,
      'warning',
      t('tts.dict.fullTitle', locale),
      t('tts.dict.full', locale, {
        max: MAX_DICTIONARY_ENTRIES,
        command: commandMention('tts dict remove'),
      })
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

/** The promise's result, or `fallback` if it takes longer than `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Voices for autocomplete: the cached list at once (refreshed in the
 * background when old), or - before the engine has ever answered - whatever
 * arrives within `AUTOCOMPLETE_WAIT_MS`.
 */
async function voicesForAutocomplete(): Promise<VoicevoxVoice[]> {
  const client = getVoicevoxClient();
  if (!client) return [];
  const cached = client.peekVoices();
  const pending = client.listVoices().catch(() => [] as VoicevoxVoice[]);
  if (cached) return cached;
  return withDeadline(pending, AUTOCOMPLETE_WAIT_MS, []);
}

export async function autocompleteTts(
  interaction: AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value).trim().toLowerCase();

  if (focused.name === 'speaker') {
    const voices = await voicesForAutocomplete();
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
    dictionary: ttsRepository.compiledDictionary(guild.id),
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

/**
 * Get the engine ready once the bot is up: the voice list for autocomplete
 * and the default voice's model. Fire-and-forget; a missing or sleeping
 * engine only means the first request pays the cost instead.
 */
export function warmUpTts(): void {
  const client = getVoicevoxClient();
  if (!client) return;
  void client.listVoices().catch((error: unknown) => {
    logger.debug(`TTS voice list warm-up failed: ${getErrorMessage(error)}`);
  });
  ttsSessions.warmUp([DEFAULT_SPEAKER_ID]);
}
