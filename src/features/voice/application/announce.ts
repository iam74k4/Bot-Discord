import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type EmbedBuilder,
  PermissionFlagsBits,
  type StageChannel,
  type VoiceChannel,
} from 'discord.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';
import {
  clearBufferingStatus,
  setBufferingStatus,
} from './voiceChannelStatus.js';

/** customId prefix of the opt-out button on the notice. */
export const OPT_OUT_PREFIX = 'voice-optout:';

/** Why the last notice for a channel could not be posted. */
export type AnnouncementProblem = 'noPermission' | 'sendFailed';

/**
 * Channels already told about buffering during this stay, so a reconnect
 * does not repeat it. Cleared when the bot leaves the channel.
 */
const announced = new Set<string>();

/**
 * The notice last posted per channel. A new stay replaces it instead of
 * stacking one more card into the chat every time the channel refills.
 * In memory only: after a restart at most one old notice is left behind.
 */
const lastNotice = new Map<string, string>();

/** Channels whose notice could not be posted, and why. */
const problems = new Map<string, AnnouncementProblem>();

export function forgetAnnouncement(channelId: string): void {
  announced.delete(channelId);
  void clearBufferingStatus(channelId);
}

/**
 * Why the buffering notice could not be posted in this channel, if it
 * could not. Shown in `/voice status` so an admin can fix the permission.
 */
export function getAnnouncementProblem(
  channelId: string
): AnnouncementProblem | undefined {
  return problems.get(channelId);
}

function minutesKept(): number {
  return Math.round(env.AUDIO_BUFFER_DURATION / 60);
}

/** What the disclosure says about the buffering itself. */
function noticeBody(locale: Locale): string {
  return t('record.notice.body', locale, {
    minutes: minutesKept(),
    hours: env.RECORDING_RETENTION_HOURS,
    command: commandMention('voice record'),
  });
}

/** The disclosure card posted into the voice channel's chat. */
export function buildNoticeEmbed(locale: Locale): EmbedBuilder {
  return createEmbed({
    title: t('record.notice.title', locale),
    description: `${noticeBody(locale)}\n\n${t('record.notice.optOut', locale, {
      command: commandMention('voice autojoin disable'),
    })}`,
    color: COLORS.WARNING,
  });
}

/**
 * The same card once an admin excluded the channel with its button: the
 * explanation stays readable, the opt-out line becomes who turned it off.
 */
export function buildOptedOutNoticeEmbed(
  locale: Locale,
  outcome: { channelId: string; userId: string; left: boolean }
): EmbedBuilder {
  const done = t('record.notice.optedOut', locale, {
    channel: outcome.channelId,
    user: `<@${outcome.userId}>`,
  });
  const left = outcome.left
    ? ` ${t('record.notice.optedOutLeft', locale)}`
    : '';
  return createEmbed({
    title: t('record.notice.title', locale),
    description: `${noticeBody(locale)}\n\n${done}${left}`,
    color: COLORS.INFO,
  });
}

function optOutRow(
  channelId: string,
  locale: Locale
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${OPT_OUT_PREFIX}${channelId}`)
      .setLabel(t('record.notice.optOutButton', locale))
      .setEmoji('🔕')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Tell the people in a voice channel that their audio is being buffered.
 *
 * The bot joins automatically and keeps several minutes of everyone's audio
 * so `/voice record` can reach back in time; posting into the channel's own
 * text chat is what makes that visible to the people actually affected. The
 * channel status (when the bot may set it and nobody else has) repeats it
 * where members see it before joining.
 *
 * Best effort by design - a missing permission or a failed send must never
 * interfere with the voice connection itself. A failure is remembered for
 * `/voice status` and the next announcement for this stay tries again.
 */
export async function announceBuffering(
  channel: VoiceChannel | StageChannel
): Promise<void> {
  if (announced.has(channel.id)) return;
  announced.add(channel.id);

  try {
    const me = channel.guild.members.me;
    if (!me) {
      announced.delete(channel.id);
      return;
    }

    const locale = resolveBackgroundLocale(channel.guild);
    void setBufferingStatus(
      channel,
      t('record.notice.channelStatus', locale, { minutes: minutesKept() })
    );

    const permissions = channel.permissionsFor(me);
    if (
      !permissions?.has(PermissionFlagsBits.ViewChannel) ||
      !permissions.has(PermissionFlagsBits.SendMessages)
    ) {
      logger.debug(
        `Cannot announce buffering in ${channel.id}: missing send permission`
      );
      problems.set(channel.id, 'noPermission');
      announced.delete(channel.id);
      return;
    }

    // Voice and stage channels have a text chat on current Discord; the
    // check stays for channels created before that.
    const channelId = channel.id;
    if (!channel.isTextBased()) {
      announced.delete(channelId);
      return;
    }

    const previous = lastNotice.get(channel.id);
    if (previous) {
      lastNotice.delete(channel.id);
      // A bot may always delete its own messages; a notice someone already
      // removed is fine too.
      await channel.messages?.delete(previous).catch(() => undefined);
    }

    const message = await channel.send({
      embeds: [buildNoticeEmbed(locale)],
      components: [optOutRow(channel.id, locale)],
    });
    problems.delete(channel.id);
    if (message?.id) {
      lastNotice.set(channel.id, message.id);
    }
  } catch (error) {
    // Keep the buffering itself working even if the disclosure fails.
    problems.set(channel.id, 'sendFailed');
    announced.delete(channel.id);
    logger.warn(
      `Failed to announce buffering in ${channel.id}: ${getErrorMessage(error)}`
    );
  }
}
