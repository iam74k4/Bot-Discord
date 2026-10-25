import {
  ChannelType,
  type Client,
  PermissionFlagsBits,
  type StageChannel,
  type VoiceChannel,
} from 'discord.js';
import { t } from '../../../locales/index.js';
import { SUPPORTED_LOCALES } from '../../../locales/types.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { connectionManager } from '../recording/connectionManager.js';

/**
 * The voice channel status (the line under a channel's name in the channel
 * list) is the one place every member sees, on every client, before they
 * join. While the bot keeps a channel's audio it says so there - but only
 * when the status is empty, and it only ever clears text it wrote itself, so
 * a status a member set is never overwritten or erased.
 *
 * discord.js has no wrapper for this yet: the permission is bit 48
 * (`SET_VOICE_CHANNEL_STATUS`), the endpoint is
 * `PUT /channels/{id}/voice-status`, and the current text is only known from
 * raw gateway events (`GUILD_CREATE` channel objects and
 * `VOICE_CHANNEL_STATUS_UPDATE`), which `observeGatewayPacket` records.
 * A channel whose status was never observed counts as unknown and is left
 * alone.
 *
 * Discord accepts the status from a member of the channel; anyone else also
 * needs Manage Channels. So the bot clears its status before it leaves
 * (`settleBufferingStatus`, run by the connection manager ahead of every
 * disconnect it makes). A status that still outlives the bot - after a kick,
 * a crash or a refused clear - is recognised by its text
 * (`isBotStatusText`): it is cleared at startup when the bot has Manage
 * Channels, taken over on the bot's next stay in that channel, and cleared
 * whenever the bot leaves that channel again.
 */
export const SET_VOICE_CHANNEL_STATUS = 1n << 48n;

/** How long to wait for the voice connection before setting the status. */
const READY_TIMEOUT_MS = 15_000;

/** Last status seen per voice channel; '' means known to be empty. */
const knownStatuses = new Map<string, string>();

type StatusPut = (status: string) => Promise<unknown>;

interface OwnStatus {
  text: string;
  put: StatusPut;
  /** The request setting `text`, while it is in flight. */
  pending?: Promise<void>;
}

/** Statuses this process set, so it clears only its own. */
const ownStatuses = new Map<string, OwnStatus>();

/** Clears in flight, so a disconnect can wait for one already started. */
const clearing = new Map<string, Promise<void>>();

/** Whether the first GUILD_CREATE's status coverage has been logged. */
let coverageLogged = false;

interface GatewayPacket {
  t?: string | null;
  d?: unknown;
}

interface RawChannel {
  id?: unknown;
  type?: unknown;
  status?: unknown;
}

let ownTextPatterns: RegExp[] | null = null;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `text` is a status this bot sets, in any supported language and
 * for any buffer length, so one left behind by a crash, a kick or an earlier
 * version is recognised as the bot's own.
 */
export function isBotStatusText(text: string | undefined): boolean {
  if (!text) return false;
  ownTextPatterns ??= SUPPORTED_LOCALES.map((locale) => {
    const marker = '\u0000';
    const template = t('record.notice.channelStatus', locale, {
      minutes: marker,
    });
    const [before, after] = template.split(marker);
    return after === undefined
      ? new RegExp(`^${escapeRegExp(before)}$`)
      : new RegExp(`^${escapeRegExp(before)}\\d+${escapeRegExp(after)}$`);
  });
  return ownTextPatterns.some((pattern) => pattern.test(text));
}

function putVia(rest: Client['rest'], channelId: string): StatusPut {
  return (status) =>
    rest.put(`/channels/${channelId}/voice-status`, { body: { status } });
}

function recordChannel(channel: RawChannel): 'voice' | 'withStatus' | null {
  if (typeof channel.id !== 'string') return null;
  if (channel.type !== ChannelType.GuildVoice) return null;
  // Only a payload that carries the field says anything about the status.
  if (!('status' in channel)) return 'voice';
  knownStatuses.set(
    channel.id,
    typeof channel.status === 'string' ? channel.status : ''
  );
  return 'withStatus';
}

/**
 * Says once whether `GUILD_CREATE` carries voice channel statuses at all:
 * without them no status is ever known to be empty and the feature stays
 * dormant, which should show up in the logs rather than look like a bug.
 */
function reportCoverageOnce(voice: number, withStatus: number): void {
  if (coverageLogged || voice === 0) return;
  coverageLogged = true;
  logger.info(
    `Voice channel status: ${withStatus} of ${voice} voice channels in the first GUILD_CREATE carried a status field` +
      (withStatus === 0 ? ' (the buffering status will not be shown)' : '')
  );
}

/** Feed every raw gateway packet through here (cheap for unrelated ones). */
export function observeGatewayPacket(packet: GatewayPacket): void {
  switch (packet.t) {
    case 'GUILD_CREATE': {
      const channels = (packet.d as { channels?: unknown } | null)?.channels;
      if (Array.isArray(channels)) {
        let voice = 0;
        let withStatus = 0;
        for (const channel of channels) {
          if (!channel || typeof channel !== 'object') continue;
          const seen = recordChannel(channel as RawChannel);
          if (seen) voice++;
          if (seen === 'withStatus') withStatus++;
        }
        reportCoverageOnce(voice, withStatus);
      }
      return;
    }
    case 'VOICE_CHANNEL_STATUS_UPDATE': {
      const data = packet.d as { id?: unknown; status?: unknown } | null;
      if (typeof data?.id === 'string') {
        knownStatuses.set(
          data.id,
          typeof data.status === 'string' ? data.status : ''
        );
      }
      return;
    }
    case 'CHANNEL_DELETE': {
      const id = (packet.d as { id?: unknown } | null)?.id;
      if (typeof id === 'string') {
        knownStatuses.delete(id);
        ownStatuses.delete(id);
      }
      return;
    }
    default:
      return;
  }
}

/** The status last seen for a channel; undefined when never observed. */
export function knownVoiceChannelStatus(channelId: string): string | undefined {
  return knownStatuses.get(channelId);
}

/** Empty, or the bot's own text: a status the bot may write. */
function isFreeOrOurs(status: string | undefined): boolean {
  return status === '' || isBotStatusText(status);
}

/**
 * Show `text` as the channel's status while the bot keeps its audio. Skips
 * quietly without the permission, for stage channels, when the current
 * status is unknown or set by someone else, and on any API error. A status
 * the bot left behind earlier is taken over rather than skipped.
 */
export async function setBufferingStatus(
  channel: VoiceChannel | StageChannel,
  text: string
): Promise<void> {
  let own: OwnStatus | undefined;
  try {
    if (channel.type !== ChannelType.GuildVoice) return;
    if (ownStatuses.has(channel.id)) return;
    if (!isFreeOrOurs(knownStatuses.get(channel.id))) return;

    const me = channel.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(SET_VOICE_CHANNEL_STATUS)) {
      return;
    }

    own = { text, put: putVia(channel.client.rest, channel.id) };
    // Claimed before any await so two announcements cannot both set it.
    ownStatuses.set(channel.id, own);

    // Without Manage Channels, Discord only accepts it from a member.
    const ready = await connectionManager.waitUntilReady(
      channel.id,
      READY_TIMEOUT_MS
    );
    if (!ready || ownStatuses.get(channel.id) !== own) {
      if (ownStatuses.get(channel.id) === own) ownStatuses.delete(channel.id);
      return;
    }
    const current = knownStatuses.get(channel.id);
    if (!isFreeOrOurs(current)) {
      // A member set a status while the connection was coming up.
      ownStatuses.delete(channel.id);
      return;
    }
    // Left over from an earlier stay and already right: just own it again.
    if (current === text) return;

    const channelId = channel.id;
    own.pending = own.put(text).then(() => {
      knownStatuses.set(channelId, text);
    });
    await own.pending;
  } catch (error) {
    if (own && ownStatuses.get(channel.id) === own) {
      ownStatuses.delete(channel.id);
    }
    logger.debug(
      `Could not set the voice status of ${channel.id}: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Remove the bot's status from a channel, unless someone has replaced it
 * since. Clears the status this process set, or - given a client - one the
 * bot left behind earlier. Best effort; concurrent calls share one request.
 */
export function clearBufferingStatus(
  channelId: string,
  client?: Client
): Promise<void> {
  const inFlight = clearing.get(channelId);
  if (inFlight) return inFlight;

  const own = ownStatuses.get(channelId);
  const put =
    own?.put ??
    (client && isBotStatusText(knownStatuses.get(channelId))
      ? putVia(client.rest, channelId)
      : undefined);
  if (!put) return Promise.resolve();
  ownStatuses.delete(channelId);

  // Runs after `clearing` holds it, so even a synchronous finish is tracked.
  const task = Promise.resolve().then(async () => {
    try {
      // A set still in flight lands first, so its text is what gets cleared.
      if (own?.pending) await own.pending.catch(() => undefined);
      if (!isBotStatusText(knownStatuses.get(channelId))) return;
      await put('');
      knownStatuses.set(channelId, '');
    } catch (error) {
      // The text stays recognisable and is cleared on a later stay.
      logger.debug(
        `Could not clear the voice status of ${channelId}: ${getErrorMessage(error)}`
      );
    } finally {
      if (clearing.get(channelId) === task) clearing.delete(channelId);
    }
  });
  clearing.set(channelId, task);
  return task;
}

/**
 * What the connection manager runs before the bot leaves a channel: clear
 * the bot's status while Discord still accepts it from the bot. Undefined
 * when there is nothing to clear, so most disconnects do not wait at all.
 */
export function settleBufferingStatus(
  channelId: string,
  client: Client
): Promise<void> | undefined {
  if (
    clearing.has(channelId) ||
    ownStatuses.has(channelId) ||
    isBotStatusText(knownStatuses.get(channelId))
  ) {
    return clearBufferingStatus(channelId, client);
  }
  return undefined;
}

/**
 * Clear statuses the bot left behind before this process started (seen in
 * `GUILD_CREATE`), where it is not connected and may still clear them:
 * that takes Manage Channels besides the status permission. The rest are
 * taken over or cleared on the bot's next stay in the channel.
 * @returns how many clears were attempted
 */
export async function clearStaleBufferingStatuses(
  client: Client
): Promise<number> {
  const tasks: Promise<void>[] = [];
  for (const [channelId, status] of knownStatuses) {
    if (!isBotStatusText(status)) continue;
    if (ownStatuses.has(channelId) || clearing.has(channelId)) continue;
    if (connectionManager.getConnection(channelId)) continue;

    const channel = client.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;
    const me = channel.guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    if (
      !permissions?.has(SET_VOICE_CHANNEL_STATUS) ||
      !permissions.has(PermissionFlagsBits.ManageChannels)
    ) {
      continue;
    }
    tasks.push(clearBufferingStatus(channelId, client));
  }
  await Promise.all(tasks);
  return tasks.length;
}

/** Forget everything (tests). */
export function resetVoiceChannelStatuses(): void {
  knownStatuses.clear();
  ownStatuses.clear();
  clearing.clear();
  coverageLogged = false;
}
