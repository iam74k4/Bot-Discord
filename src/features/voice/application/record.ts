import {
  AttachmentBuilder,
  ChannelType,
  ChatInputCommandInteraction,
  DiscordAPIError,
  type EmbedBuilder,
  type Guild,
  GuildMember,
  HTTPError,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type StageChannel,
  type VoiceChannel,
} from 'discord.js';
import { createEmbed, createErrorEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import {
  createErrorId,
  describeError,
} from '../../../shared/interactions/index.js';
import { releaseCooldown } from '../../../middleware/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveLocale } from '../../../locales/guildLocale.js';
import { formatDuration } from '../../../locales/format.js';
import { env, DISCORD_LIMITS, RETRY } from '../../../config/index.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import type { RecordingResult } from '../../../shared/types/voice.js';
import { connectionManager } from '../recording/connectionManager.js';
import {
  parseDurationString,
  recordAudio,
  RecordingInProgressError,
  RecordingNoAudibleAudioError,
} from '../recording/recordingService.js';
import {
  describeBufferingGap,
  diagnoseBufferingGap,
  isBuffering,
} from './diagnose.js';
import { announceBuffering } from './announce.js';

const BYTES_PER_MB = 1024 * 1024;
const RECORD_COMMAND = 'voice record';

type Reply = Parameters<ChatInputCommandInteraction['reply']>[0];

/** `30秒` / `30 seconds`, `5分` / `5 minutes`. */
function spokenDuration(seconds: number, locale: Locale): string {
  return formatDuration(seconds * 1000, locale, {
    style: 'long',
    precision: 'seconds',
  });
}

/** `1:05` - offsets inside a clip. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function megabytes(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(2);
}

/** Discord refused the request itself; sending it again changes nothing. */
function isPermanentRejection(error: unknown): boolean {
  return (
    (error instanceof DiscordAPIError || error instanceof HTTPError) &&
    error.status >= 400 &&
    error.status < 500
  );
}

function isTooLarge(error: unknown): boolean {
  if (error instanceof DiscordAPIError) {
    return (
      error.status === 413 ||
      error.code === RESTJSONErrorCodes.RequestEntityTooLarge
    );
  }
  // A 413 from Discord's edge arrives as an HTML page without a JSON code.
  return error instanceof HTTPError && error.status === 413;
}

function isMissingPermission(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.code === RESTJSONErrorCodes.MissingPermissions
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send, retrying with exponential backoff (1 s, 2 s, 4 s ... capped at
 * 10 s) on network and server errors. A 4xx is thrown at once: Discord
 * rejected the request itself (too large, missing permission, expired
 * token), so re-uploading the same file would fail the same way. Server
 * errors are already retried inside @discordjs/rest; this outer loop is for
 * whatever still slips through.
 */
async function sendWithRetry(
  send: () => Promise<unknown>,
  label: string
): Promise<void> {
  const maxRetries = RETRY.RECORDING_RETRY_MAX;
  for (let attempt = 0; ; attempt++) {
    try {
      await send();
      return;
    } catch (error) {
      if (isPermanentRejection(error) || attempt >= maxRetries) throw error;
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      logger.warn(
        `Failed to send ${label} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
}

/** One file to deliver. */
interface Deliverable {
  /** In-memory WAV, or a path to read when the result carries no bytes. */
  attachment: Buffer | string;
  name: string;
  size: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

function fileNameOf(path: string, fallback: string): string {
  return path.split(/[/\\]/).pop() || fallback;
}

function deliverablesOf(result: RecordingResult): Deliverable[] {
  const fallbackName = (index: number) =>
    index === 0 ? 'recording.wav' : 'recording_part.wav';

  if (result.parts && result.parts.length > 0) {
    return result.parts.map((part, index) => ({
      attachment: part.data,
      name: fileNameOf(part.filePath, fallbackName(index)),
      size: part.size,
      startSeconds: part.startSeconds,
      endSeconds: part.endSeconds,
    }));
  }

  const paths = [result.filePath, ...(result.additionalFiles ?? [])];
  return paths.map((path, index) => ({
    attachment: path,
    name: fileNameOf(path, fallbackName(index)),
    size: paths.length === 1 ? result.fileSize : null,
    startSeconds: null,
    endSeconds: null,
  }));
}

function partLabel(
  part: Deliverable,
  index: number,
  total: number,
  locale: Locale
): string {
  if (part.startSeconds === null || part.endSeconds === null) {
    return t('record.partLabelShort', locale, { part: index + 1, total });
  }
  return t('record.partLabel', locale, {
    part: index + 1,
    total,
    from: clock(part.startSeconds),
    to: clock(part.endSeconds),
  });
}

function isVoiceChannel(
  channel: unknown
): channel is VoiceChannel | StageChannel {
  const type = (channel as { type?: unknown } | null)?.type;
  return (
    type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice
  );
}

/**
 * Turn the request down before anything was acknowledged. The cooldown is
 * given back: every refusal here is something the user can fix and retry.
 */
async function refuse(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder
): Promise<void> {
  releaseCooldown(interaction);
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  } satisfies Reply);
}

/** Guilds whose upload limit has been logged (once per process each). */
const loggedUploadLimits = new Set<string>();

/** Upload limit for this interaction, falling back when Discord sent none. */
function uploadLimitOf(interaction: ChatInputCommandInteraction): number {
  const limit = interaction.attachmentSizeLimit;
  const known = typeof limit === 'number' && limit > 0;
  const guildKey = interaction.guildId ?? interaction.guild?.id ?? 'dm';
  if (!loggedUploadLimits.has(guildKey)) {
    loggedUploadLimits.add(guildKey);
    logger.debug(
      `Upload limit for guild ${guildKey}: ${known ? `${limit} bytes` : 'not sent, using the fallback'}`
    );
  }
  return known ? limit : DISCORD_LIMITS.FALLBACK_ATTACHMENT_BYTES;
}

export async function executeRecordCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const durationStr = interaction.options.getString('duration', true);

  if (!interaction.guild || !interaction.member) {
    await refuse(
      interaction,
      createErrorEmbed(t('common.error', locale), t('common.guildOnly', locale))
    );
    return;
  }

  const guild = interaction.guild;
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!isVoiceChannel(voiceChannel)) {
    await refuse(
      interaction,
      createErrorEmbed(
        t('record.errors.notInVoice', locale),
        t('record.errors.notInVoiceDesc', locale)
      )
    );
    return;
  }

  // Every check below is synchronous, so a refusal is the first and only
  // answer: no "thinking..." placeholder that then turns into an error.
  let duration: number;
  try {
    duration = parseDurationString(durationStr);
  } catch {
    await refuse(
      interaction,
      createErrorEmbed(
        t('record.errors.invalidDuration', locale),
        t('record.errors.invalidDurationDesc', locale)
      )
    );
    return;
  }

  if (duration > env.MAX_RECORDING_DURATION) {
    await refuse(
      interaction,
      createErrorEmbed(
        t('record.errors.durationTooLong', locale),
        t('record.errors.durationTooLongDesc', locale, {
          max: spokenDuration(env.MAX_RECORDING_DURATION, locale),
        })
      )
    );
    return;
  }

  if (duration > env.AUDIO_BUFFER_DURATION) {
    await refuse(
      interaction,
      createErrorEmbed(
        t('record.errors.durationExceedsBuffer', locale),
        t('record.errors.durationExceedsBufferDesc', locale, {
          buffer: spokenDuration(env.AUDIO_BUFFER_DURATION, locale),
        })
      )
    );
    return;
  }

  const botMember = guild.members.me;
  if (!botMember) {
    await refuse(
      interaction,
      createErrorEmbed(
        t('common.error', locale),
        t('record.errors.botUnavailable', locale)
      )
    );
    return;
  }

  const channel = interaction.channel;
  if (channel && 'permissionsFor' in channel) {
    const permissions = channel.permissionsFor(botMember);
    if (
      !permissions ||
      !permissions.has(PermissionFlagsBits.AttachFiles) ||
      !permissions.has(PermissionFlagsBits.ViewChannel)
    ) {
      await refuse(
        interaction,
        createErrorEmbed(
          t('record.errors.noPermission', locale),
          t('record.errors.noPermissionDesc', locale, {
            channel: interaction.channelId,
          })
        )
      );
      return;
    }
  }

  if (!isBuffering(voiceChannel.id)) {
    await explainNotBuffered(interaction, guild, voiceChannel, locale);
    return;
  }

  await interaction.reply({
    embeds: [
      createEmbed({
        title: t('record.recording', locale),
        description: `${t('record.recordingDesc', locale, {
          duration: spokenDuration(duration, locale),
        })}\n\n${t('record.inProgressNote', locale)}`,
        color: COLORS.PRIMARY,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });

  const uploadLimit = uploadLimitOf(interaction);
  let mainDelivered = false;
  let attemptedBytes: number | null = null;

  try {
    const result = await recordAudio({
      duration,
      channelId: voiceChannel.id,
      userId: interaction.user.id,
      guildId: guild.id,
      maxUploadBytes: uploadLimit,
    });

    metrics.recordVoiceRecording(result.duration);

    const parts = deliverablesOf(result);
    const totalFiles = parts.length;
    const attachments = parts.map(
      (part) => new AttachmentBuilder(part.attachment, { name: part.name })
    );

    let description = t('record.successDesc', locale, {
      duration: spokenDuration(result.duration, locale),
    });
    if (result.duration < (result.requestedDuration ?? duration)) {
      const available = spokenDuration(result.duration, locale);
      description += `\n${t('record.trimmedNote', locale, { available })}`;
    }
    description += `\n\n${t('record.saveWarning', locale)}`;

    // The progress message becomes the result: one message, with the file.
    attemptedBytes = parts[0].size;
    await sendWithRetry(
      () =>
        interaction.editReply({
          embeds: [
            createEmbed({
              title: t('record.success', locale),
              description,
              color: COLORS.SUCCESS,
              footer: result.isSplit
                ? t('record.fileSizeSplit', locale, {
                    size: megabytes(result.fileSize),
                    count: totalFiles,
                  })
                : t('record.fileSize', locale, {
                    size: megabytes(result.fileSize),
                  }),
              timestamp: true,
            }),
          ],
          files: [attachments[0]],
        }),
      'recording file'
    );
    mainDelivered = true;

    const failedParts: number[] = [];
    for (let i = 1; i < parts.length; i++) {
      try {
        await sendWithRetry(
          () =>
            interaction.followUp({
              content: partLabel(parts[i], i, totalFiles, locale),
              files: [attachments[i]],
              flags: MessageFlags.Ephemeral,
            }),
          `recording part ${i + 1}`
        );
      } catch (error) {
        logger.error(
          `Failed to send split file part ${i + 1}:`,
          getErrorMessage(error)
        );
        failedParts.push(i + 1);
      }
    }

    if (failedParts.length > 0) {
      const partsLabel = failedParts.join(', ');
      logger.error(
        `Recording delivery incomplete for channel ${voiceChannel.id}: failed parts ${partsLabel}`
      );
      await interaction.followUp({
        embeds: [
          createErrorEmbed(
            t('record.errors.deliveryIncomplete', locale),
            t('record.errors.deliveryIncompleteDesc', locale, {
              parts: partsLabel,
              total: totalFiles,
              command: commandMention(RECORD_COMMAND),
            })
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    logger.info(
      `Recording completed: ${result.duration}s from channel ${voiceChannel.name} (${voiceChannel.id}) by ${interaction.user.tag}`
    );
  } catch (error) {
    const embed = failureEmbed(error, {
      locale,
      channelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      duration,
      uploadLimit,
      attemptedBytes,
    });
    if (
      error instanceof RecordingNoAudibleAudioError ||
      error instanceof RecordingInProgressError
    ) {
      // Nothing was produced; trying again right away is fine.
      releaseCooldown(interaction);
    }

    // Once the file is out, never overwrite the message that carries it.
    const report = mainDelivered
      ? interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral })
      : interaction.editReply({ embeds: [embed] });
    await report.catch((reportError: unknown) => {
      logger.debug(
        'Failed to report a recording failure:',
        getErrorMessage(reportError)
      );
    });
  }
}

interface FailureContext {
  locale: Locale;
  channelId: string;
  textChannelId: string | null;
  duration: number;
  uploadLimit: number;
  attemptedBytes: number | null;
}

function failureEmbed(error: unknown, context: FailureContext): EmbedBuilder {
  const { locale } = context;

  if (error instanceof RecordingNoAudibleAudioError) {
    logger.warn(
      `Recording had no audible audio for channel ${context.channelId}`
    );
    // What was actually checked: less than asked for when the bot has not
    // been hearing the channel that long, and then a longer window cannot
    // help - there is nothing older to reach.
    const checked = error.checkedSeconds ?? context.duration;
    const heard = Math.min(context.duration, checked);
    let description = t('record.errors.noAudibleAudioDesc', locale, {
      duration: spokenDuration(heard > 0 ? heard : context.duration, locale),
    });
    if (
      checked >= context.duration &&
      context.duration < env.MAX_RECORDING_DURATION
    ) {
      description += `\n${t('record.errors.noAudibleAudioLongerHint', locale)}`;
    }
    return createErrorEmbed(
      t('record.errors.noAudibleAudio', locale),
      description
    );
  }

  if (error instanceof RecordingInProgressError) {
    return createErrorEmbed(
      t('record.errors.busy', locale),
      t('record.errors.busyDesc', locale)
    );
  }

  if (isTooLarge(error)) {
    logger.warn(
      `Recording upload rejected as too large for channel ${context.channelId}: ` +
        `${context.attemptedBytes ?? 'unknown'} bytes against a limit of ${context.uploadLimit}`
    );
    return createErrorEmbed(
      t('record.errors.tooLarge', locale),
      t('record.errors.tooLargeDesc', locale, {
        size: megabytes(context.attemptedBytes ?? 0),
        limit: Math.floor(context.uploadLimit / BYTES_PER_MB),
        command: commandMention(RECORD_COMMAND),
      })
    );
  }

  if (isMissingPermission(error)) {
    return createErrorEmbed(
      t('record.errors.noPermission', locale),
      t('record.errors.noPermissionDesc', locale, {
        channel: context.textChannelId ?? context.channelId,
      })
    );
  }

  const errorId = createErrorId();
  logger.error(
    `[${errorId}] Recording failed for channel ${context.channelId}:`,
    describeError(error)
  );
  return createErrorEmbed(
    t('record.errors.failed', locale),
    t('record.errors.failedDesc', locale, { id: errorId })
  );
}

/**
 * The bot is not keeping this channel's audio. Say why and what to do; when
 * nothing actually stands in the way (auto-join simply has not happened
 * yet), join now so the next attempt works.
 */
async function explainNotBuffered(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  voiceChannel: VoiceChannel | StageChannel,
  locale: Locale
): Promise<void> {
  const gap = diagnoseBufferingGap(guild, voiceChannel);
  const beforeJoin = t('record.notBuffered.beforeJoinNote', locale);

  if (gap.reason === 'notYetJoined') {
    const connection = await connectionManager.connect(guild, voiceChannel);
    if (connection) {
      logger.info(
        `Joined ${voiceChannel.name} (${voiceChannel.id}) on demand for /voice record`
      );
      void announceBuffering(voiceChannel);
      await refuse(
        interaction,
        createEmbed({
          title: t('record.notBuffered.startedTitle', locale),
          description: `${t('record.notBuffered.startedNow', locale)}\n${beforeJoin}`,
          color: COLORS.INFO,
        })
      );
      return;
    }
  }

  await refuse(
    interaction,
    createErrorEmbed(
      t('record.errors.notBuffered', locale),
      `${describeBufferingGap(gap, voiceChannel.id, locale)}\n${beforeJoin}`
    )
  );
}
