import { Events, Guild, VoiceState, escapeMarkdown } from 'discord.js';
import { Event } from '../../../shared/types/index.js';
import { ExtendedClient } from '../../../client.js';
import { createEmbed } from '../../../shared/utils/embed.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { isGuildAllowed } from '../../../shared/utils/guildAllowlist.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';
import { notificationChannelRepository } from '../repositories/notificationChannelRepository.js';
import { voiceTracker } from '../tracking/voiceTracker.js';
import { getSendableTextChannel } from '../../../shared/utils/discord.js';
import {
  isVoiceDigestEmpty,
  summarizeVoiceActivity,
  type VoiceActivity,
  type VoiceDigest,
} from '../application/voiceDigest.js';

/**
 * How long a guild's voice notifications stay batched after one is sent.
 *
 * This is a throttle with a trailing digest, not a plain debounce: the first
 * change is announced immediately so "someone is in the call" still arrives
 * promptly, and everything that follows within the window is collapsed into a
 * single summary. A channel filling up costs two messages instead of ten.
 *
 * One kind of change is never held back: someone joining a VC that was empty
 * (a call starting) flushes the window at once, together with whatever had
 * been waiting, because that is the notification people act on.
 */
export const DIGEST_WINDOW_MS = 30_000;

interface DigestWindow {
  timer: NodeJS.Timeout;
  buffered: VoiceActivity[];
  guild: Guild;
}

/** Open windows keyed by guild id. */
const windows = new Map<string, DigestWindow>();

export const event: Event<typeof Events.VoiceStateUpdate> = {
  name: Events.VoiceStateUpdate,
  once: false,
  async execute(
    client: ExtendedClient,
    oldState: VoiceState,
    newState: VoiceState
  ) {
    if (!client.isFullyReady) return;
    if (newState.member?.user.bot) return;
    // Neither notices nor VC time tracking for a server outside
    // ALLOWED_GUILD_IDS.
    if (!isGuildAllowed(newState.guild.id)) return;

    const guildId = newState.guild.id;

    if (!oldState.channel && newState.channel) {
      await handleJoin(client, guildId, newState);
      return;
    }

    if (oldState.channel && !newState.channel) {
      await handleLeave(guildId, oldState);
      return;
    }

    if (
      oldState.channel &&
      newState.channel &&
      oldState.channel.id !== newState.channel.id
    ) {
      await handleMove(client, guildId, oldState, newState);
    }
  },
};

/**
 * Whether `state` is in the guild's AFK channel. Discord moves idle members
 * there on its own, so being in it counts as having left VC: no notification
 * line and no stats time.
 */
function isAfk(state: VoiceState): boolean {
  const channelId = state.channel?.id;
  return channelId !== undefined && channelId === state.guild.afkChannelId;
}

/**
 * Whether `state` is the first person into its channel: nobody else was
 * there, not counting bots (the bot's own recording or TTS connection
 * included). Read from the guild's voice-state cache, which has an entry for
 * everyone in a VC even when their member object is not cached; a state
 * whose member is unknown counts as a person, which only means batching.
 */
function startsCall(client: ExtendedClient, state: VoiceState): boolean {
  const channelId = state.channel?.id;
  const states = state.guild.voiceStates?.cache;
  if (!channelId || !states || isAfk(state)) return false;

  const joinerId = state.member?.user.id ?? state.id;
  for (const other of states.values()) {
    if (other.id === joinerId || other.channelId !== channelId) continue;
    const isBot = other.member?.user.bot ?? other.id === client.user?.id;
    if (!isBot) return false;
  }
  return true;
}

function startSessionFromState(guildId: string, state: VoiceState): void {
  if (!state.member || !state.channel || isAfk(state)) return;
  voiceTracker.startSession(
    guildId,
    state.member.user.id,
    state.channel.id,
    state.channel.name
  );
}

function endSessionFromState(guildId: string, state: VoiceState): void {
  if (!state.member) return;
  voiceTracker.endSession(guildId, state.member.user.id);
}

function toActivity(
  state: VoiceState,
  kind: VoiceActivity['kind']
): VoiceActivity | null {
  if (!state.member || !state.channel || isAfk(state)) return null;
  return {
    userId: state.member.user.id,
    // Shown inside **bold**: a name like `*star*` must not break it.
    displayName: escapeMarkdown(state.member.displayName),
    channelId: state.channel.id,
    kind,
  };
}

async function handleJoin(
  client: ExtendedClient,
  guildId: string,
  state: VoiceState
): Promise<void> {
  try {
    startSessionFromState(guildId, state);
  } catch (error) {
    logger.error(`Failed to start voice session: ${getErrorMessage(error)}`);
  }

  await recordActivity(
    guildId,
    state.guild,
    [toActivity(state, 'join')],
    startsCall(client, state)
  );
}

async function handleLeave(guildId: string, state: VoiceState): Promise<void> {
  try {
    endSessionFromState(guildId, state);
  } catch (error) {
    logger.error(`Failed to end voice session: ${getErrorMessage(error)}`);
  }

  await recordActivity(guildId, state.guild, [toActivity(state, 'leave')]);
}

/**
 * Move must finish the session transition before any Discord I/O.
 * Event listeners are not awaited by the dispatcher, so a concurrent leave
 * during leave-notify can otherwise race ahead of startSession and leave a
 * ghost open session for a channel the user already left.
 *
 * A move into the AFK channel reads as a leave and a move out of it as a
 * join, because the AFK half produces no activity.
 */
async function handleMove(
  client: ExtendedClient,
  guildId: string,
  oldState: VoiceState,
  newState: VoiceState
): Promise<void> {
  try {
    endSessionFromState(guildId, oldState);
    startSessionFromState(guildId, newState);
  } catch (error) {
    logger.error(
      `Failed to transition voice session on move: ${getErrorMessage(error)}`
    );
  }

  // Both halves are handed over together so a move outside an open window is
  // still reported as one line rather than a leave now and a join later.
  await recordActivity(
    guildId,
    newState.guild,
    [toActivity(oldState, 'leave'), toActivity(newState, 'join')],
    startsCall(client, newState)
  );
}

/**
 * Announce immediately when the guild has no open window, otherwise buffer
 * until the window closes - unless the change starts a call, which flushes
 * the window now and restarts it.
 */
async function recordActivity(
  guildId: string,
  guild: Guild,
  activities: ReadonlyArray<VoiceActivity | null>,
  urgent: boolean = false
): Promise<void> {
  const events = activities.filter((a): a is VoiceActivity => a !== null);
  if (events.length === 0) return;

  const open = windows.get(guildId);
  if (open) {
    open.guild = guild;
    if (!urgent) {
      open.buffered.push(...events);
      return;
    }

    const pending = [...open.buffered, ...events];
    open.buffered = [];
    clearTimeout(open.timer);
    open.timer = setTimeout(() => void closeWindow(guildId), DIGEST_WINDOW_MS);
    await sendDigest(guild, summarizeVoiceActivity(pending));
    return;
  }

  if (!notificationChannelRepository.getEnabled(guildId, 'voice')) return;

  windows.set(guildId, {
    buffered: [],
    guild,
    timer: setTimeout(() => void closeWindow(guildId), DIGEST_WINDOW_MS),
  });

  await sendDigest(guild, summarizeVoiceActivity(events));
}

/**
 * Flush whatever accumulated. A window that collected nothing closes; one
 * that did stays open so a continuing burst keeps being batched.
 */
async function closeWindow(guildId: string): Promise<void> {
  const open = windows.get(guildId);
  if (!open) return;

  if (open.buffered.length === 0) {
    windows.delete(guildId);
    return;
  }

  const digest = summarizeVoiceActivity(open.buffered);
  open.buffered = [];
  open.timer = setTimeout(() => void closeWindow(guildId), DIGEST_WINDOW_MS);

  if (!isVoiceDigestEmpty(digest)) {
    await sendDigest(open.guild, digest);
  }
}

function digestLines(digest: VoiceDigest, locale: Locale): string[] {
  return [
    ...digest.joined.map((entry) =>
      t('notification.events.voiceJoin', locale, {
        name: entry.displayName,
        channel: entry.channelId,
      })
    ),
    ...digest.moved.map((entry) =>
      t('notification.events.voiceMove', locale, {
        name: entry.displayName,
        from: entry.fromChannelId,
        to: entry.toChannelId,
      })
    ),
    ...digest.left.map((entry) =>
      t('notification.events.voiceLeave', locale, {
        name: entry.displayName,
        channel: entry.channelId,
      })
    ),
  ];
}

async function sendDigest(guild: Guild, digest: VoiceDigest): Promise<void> {
  if (isVoiceDigestEmpty(digest)) return;

  const notifyChannelId = notificationChannelRepository.getEnabled(
    guild.id,
    'voice'
  );
  if (!notifyChannelId) return;

  try {
    const textChannel = await getSendableTextChannel(guild, notifyChannelId);
    if (!textChannel) return;

    const locale = resolveBackgroundLocale(guild);
    const lines = digestLines(digest, locale);
    // A single change keeps its old one-line look; only a real batch gets a
    // heading, so the common case is not made noisier by the batching.
    const isBatch = lines.length > 1;

    const embed = createEmbed({
      title: isBatch
        ? t('notification.events.voiceDigestTitle', locale)
        : undefined,
      description: lines.join('\n'),
      color:
        digest.joined.length > 0 || digest.moved.length > 0
          ? COLORS.SUCCESS
          : COLORS.ERROR,
      timestamp: true,
    });

    await textChannel.send({ embeds: [embed] });
  } catch (error) {
    logger.warn(
      `Failed to send voice notification digest: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Drop every open window. Called on shutdown so pending timers cannot keep
 * the process alive or fire against a destroyed client.
 */
export function resetVoiceDigests(): void {
  for (const open of windows.values()) {
    clearTimeout(open.timer);
  }
  windows.clear();
}
