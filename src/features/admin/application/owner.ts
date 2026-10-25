import {
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  escapeMarkdown,
  type Guild,
} from 'discord.js';
import {
  createEmbed,
  createErrorEmbed,
  createWarningEmbed,
} from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { isBotOwner } from '../../../config/env.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { TimeoutError, withTimeout } from '../../../shared/utils/timeout.js';
import { t, type Locale } from '../../../locales/index.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import {
  resolveBackgroundLocale,
  resolveLocale,
} from '../../../locales/guildLocale.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { awaitConfirmationResult } from '../../../shared/utils/confirm.js';
import { showAdminSystemPanel } from './systemPanel.js';
import { checkPostableChannel } from './channelCheck.js';
import { runBackupSafely } from './backupRun.js';

/** Limit broadcast fan-out per invocation (rate limits / UX). */
const BROADCAST_MAX_GUILDS = 250;
/**
 * Announcements in flight at once. Delivery to one server at a time made a
 * large broadcast take minutes; more lanes than this would mostly queue
 * behind Discord's global rate limit and delay everyone else's
 * notifications.
 */
export const BROADCAST_CONCURRENCY = 3;
/** Progress edits are throttled to one per this many ms. */
export const BROADCAST_PROGRESS_INTERVAL_MS = 2_000;
/** A server whose channel does not answer within this counts as failed. */
const BROADCAST_TIMEOUT = 5_000;
/** Failed servers named in the result; the rest are counted. */
const BROADCAST_FAILURES_LISTED = 10;

function checkOwner(interaction: ChatInputCommandInteraction): boolean {
  return isBotOwner(interaction.user.id);
}

export interface BroadcastTarget<G> {
  guild: G;
  channelId: string;
}

export interface BroadcastPlan<G> {
  /** Guilds this run will actually post to, already capped. */
  targets: BroadcastTarget<G>[];
  /** Guilds with no announcement channel. Not failures - they never opted in. */
  skipped: number;
  /** Addressable guilds left out because the run hit `BROADCAST_MAX_GUILDS`. */
  overCap: number;
}

/**
 * Decide who a broadcast goes to.
 *
 * Split out from the send loop because the interesting rule is here: a guild
 * that never nominated a channel is skipped rather than counted as a delivery
 * failure, so an owner reading the result can tell "nobody opted in" apart
 * from "delivery is broken".
 */
export function planBroadcast<G extends { id: string }>(
  guilds: readonly G[],
  announcementChannelOf: (guildId: string) => string | null,
  cap = BROADCAST_MAX_GUILDS
): BroadcastPlan<G> {
  const addressable = guilds.flatMap((guild) => {
    const channelId = announcementChannelOf(guild.id);
    return channelId ? [{ guild, channelId }] : [];
  });

  return {
    targets: addressable.slice(0, cap),
    skipped: guilds.length - addressable.length,
    overCap: Math.max(0, addressable.length - cap),
  };
}

/**
 * Run `worker` over `items` with at most `limit` running at once, each lane
 * taking the next item as soon as it is free. `worker` must not throw.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane)
  );
}

type FailureReason = 'notSendable' | 'timeout' | 'sendFailed';

/** A configured channel that is deleted or no longer postable. */
class NotSendableError extends Error {
  constructor(channelId: string) {
    super(`Announcement channel ${channelId} is not sendable`);
    this.name = 'NotSendableError';
  }
}

/**
 * Post the announcement to one server, in that server's language. Returns
 * why it did not arrive, or null when it did.
 */
async function deliverAnnouncement(
  guild: Guild,
  channelId: string,
  message: string
): Promise<FailureReason | null> {
  try {
    const check = await checkPostableChannel(guild, channelId);
    if (!check.ok) {
      // Configured but no longer usable: deleted, or the bot lost access.
      throw new NotSendableError(channelId);
    }

    const locale = resolveBackgroundLocale(guild);
    const embed = new EmbedBuilder()
      .setTitle(t('owner.broadcast.embedTitle', locale))
      .setDescription(message)
      .setColor(COLORS.INFO)
      .setFooter({ text: t('owner.broadcast.embedFooter', locale) })
      .setTimestamp();

    await withTimeout(
      check.channel.send({ embeds: [embed] }),
      BROADCAST_TIMEOUT
    );
    return null;
  } catch (error) {
    logger.debug(
      `Failed to send broadcast to guild ${guild.id}:`,
      getErrorMessage(error)
    );
    if (error instanceof NotSendableError) return 'notSendable';
    return error instanceof TimeoutError ? 'timeout' : 'sendFailed';
  }
}

function formatFailures(
  failures: ReadonlyArray<{
    index: number;
    guild: Guild;
    reason: FailureReason;
  }>,
  locale: Locale
): string {
  if (failures.length === 0) return '';

  const listed = [...failures]
    .sort((a, b) => a.index - b.index)
    .slice(0, BROADCAST_FAILURES_LISTED)
    .map(
      ({ guild, reason }) =>
        `• ${escapeMarkdown(guild.name)} — ${t(
          `owner.broadcast.failureReasons.${reason}`,
          locale
        )}`
    );
  const hidden = failures.length - listed.length;
  if (hidden > 0) {
    listed.push(t('owner.broadcast.moreFailures', locale, { count: hidden }));
  }

  return t('owner.broadcast.failures', locale, { list: listed.join('\n') });
}

async function handleBroadcast(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const message = interaction.options.getString('message', true);

  const allGuilds = [...interaction.client.guilds.cache.values()];
  const totalGuilds = allGuilds.length;
  const {
    targets: guilds,
    skipped,
    overCap,
  } = planBroadcast(
    allGuilds,
    guildSettingsRepository.getAnnouncementChannel,
    BROADCAST_MAX_GUILDS
  );
  const addressable = guilds.length + overCap;
  const capped = overCap > 0;

  if (guilds.length === 0) {
    await interaction.reply({
      embeds: [
        createWarningEmbed(
          t('common.warning', locale),
          t('owner.broadcast.noChannel', locale, {
            command: commandMention('admin settings announcements'),
          })
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const confirmation = await awaitConfirmationResult(
    interaction,
    t('owner.broadcast.confirm', locale, {
      count: guilds.length,
      total: totalGuilds,
      message,
    }),
    {
      ephemeral: true,
      timeout: 45_000,
      title: t('owner.broadcast.confirmTitle', locale),
      confirmLabel: t('owner.broadcast.confirmLabel', locale),
    }
  );
  // Cancelled, timed out or closed by a restart: the prompt already says so.
  if (confirmation.outcome !== 'confirmed') return;

  const capNote = capped
    ? t('owner.broadcast.progressCap', locale, {
        limit: BROADCAST_MAX_GUILDS,
        total: addressable,
      })
    : '';
  let sent = 0;
  let failed = 0;
  let processed = 0;
  const failures: Array<{
    index: number;
    guild: Guild;
    reason: FailureReason;
  }> = [];
  const progress = () =>
    t('owner.broadcast.progress', locale, {
      processed,
      total: guilds.length,
      sent,
      failed,
      capNote,
    });

  // The press is answered by replacing the prompt with the progress line. If
  // that fails, nothing has been sent and the error reaches the router.
  await confirmation.response.update({
    content: progress(),
    embeds: [],
    components: [],
  });

  // Progress edits are throttled, never awaited by a lane (a slow edit must
  // not slow delivery), and chained so they land in order; the summary
  // waits for the last one so a late progress edit cannot overwrite it.
  let lastProgressAt = Date.now();
  let progressEdits: Promise<void> = Promise.resolve();
  const reportProgress = () => {
    const now = Date.now();
    if (now - lastProgressAt < BROADCAST_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    progressEdits = progressEdits.then(() =>
      interaction.editReply({ content: progress(), embeds: [] }).then(
        () => undefined,
        (error: unknown) => {
          logger.debug(
            `Failed to edit broadcast progress: ${getErrorMessage(error)}`
          );
        }
      )
    );
  };

  await runWithConcurrency(
    guilds,
    BROADCAST_CONCURRENCY,
    async ({ guild, channelId }, index) => {
      const reason = await deliverAnnouncement(guild, channelId, message);
      if (reason) {
        failed++;
        failures.push({ index, guild, reason });
      } else {
        sent++;
      }
      processed++;
      reportProgress();
    }
  );
  await progressEdits;

  const capLine = capped
    ? t('owner.broadcast.capNote', locale, {
        limit: BROADCAST_MAX_GUILDS,
        total: addressable,
      })
    : '';

  await interaction.editReply({
    content: '',
    embeds: [
      createEmbed({
        title: t('owner.broadcast.completeTitle', locale),
        description:
          t('owner.broadcast.complete', locale, {
            sent,
            failed,
            skipped,
            capNote: capLine,
          }) + formatFailures(failures, locale),
        color: COLORS.SUCCESS,
        timestamp: true,
      }),
    ],
  });
}

async function handleBackupRun(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);
  const confirmation = await awaitConfirmationResult(
    interaction,
    t('owner.backup.confirm', locale),
    {
      ephemeral: true,
      title: t('owner.backup.confirmTitle', locale),
      confirmLabel: t('owner.backup.confirmLabel', locale),
      confirmStyle: ButtonStyle.Success,
    }
  );
  if (confirmation.outcome !== 'confirmed') return;

  await confirmation.response.update({
    content: t('owner.backup.running', locale),
    embeds: [],
    components: [],
  });

  const result = await runBackupSafely();

  const embed = result.success
    ? createEmbed({
        title: t('owner.backup.completeTitle', locale),
        description: t('owner.backup.complete', locale, {
          filename: result.filename,
          size: Math.round(result.size / 1024),
        }),
        color: COLORS.SUCCESS,
        timestamp: true,
      })
    : createErrorEmbed(
        t('owner.backup.failedTitle', locale),
        t('owner.backup.failed', locale, {
          error: result.error || t('owner.backup.noReason', locale),
        })
      );
  await interaction.editReply({ content: '', embeds: [embed] });
}

export async function executeOwnerCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const locale = resolveLocale(interaction);

  if (!checkOwner(interaction)) {
    await interaction.reply({
      embeds: [
        createWarningEmbed(
          t('common.permissionDeniedTitle', locale),
          t('owner.errors.ownerOnly', locale)
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (group === 'backup') {
    switch (subcommand) {
      case 'list':
        await showAdminSystemPanel(interaction, locale, 'backups');
        break;
      case 'run':
        await handleBackupRun(interaction);
        break;
    }
    return;
  }

  switch (subcommand) {
    case 'stats':
    case 'db':
    case 'guilds':
    case 'health':
    case 'metrics':
      await showAdminSystemPanel(interaction, locale, subcommand);
      break;
    case 'broadcast':
      await handleBroadcast(interaction);
      break;
  }
}
