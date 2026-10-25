import {
  AudioPlayer,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  joinVoiceChannel,
  entersState,
  EndBehaviorType,
} from '@discordjs/voice';
import {
  Guild,
  VoiceChannel,
  StageChannel,
  PermissionFlagsBits,
} from 'discord.js';
import { Readable } from 'stream';
import prism from 'prism-media';
import { env, AUDIO } from '../../../config/index.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import {
  VoiceConnectionInfo,
  VoiceConnectionState,
} from '../../../shared/types/voice.js';
import { channelMixRingManager } from './channelMixRing.js';
import { ChunkPlacer } from './chunkPlacer.js';

/**
 * opusscript (the bundled Opus backend) runs every decoder in one 16 MiB
 * wasm heap. Past roughly 29 live mono decoders per process (20 stereo) a
 * new one fails with "memory access out of bounds" and that speaker is
 * simply missing from recordings. Decoding to mono raises the cap; installing
 * the native `@discordjs/opus` (which prism-media prefers automatically)
 * removes it. Failures are counted and reported at warn level, at most once
 * a minute, so a busy server shows up in the logs instead of going silent.
 */
const OPUS_HEAP_EXHAUSTED = 'memory access out of bounds';
const DECODER_WARNING_INTERVAL_MS = 60_000;

let liveDecoders = 0;
let lastDecoderWarningAt = Number.NEGATIVE_INFINITY;
let backendLogged = false;

/** Number of Opus decoders currently open across every connection. */
export function getLiveDecoderCount(): number {
  return liveDecoders;
}

/** The Opus module prism-media loaded, once it has loaded one. */
function opusBackendName(): string | undefined {
  return (prism.opus.Decoder as unknown as { type?: string }).type;
}

function logOpusBackendOnce(): void {
  if (backendLogged) return;
  backendLogged = true;
  logger.info(`Opus decoder backend: ${opusBackendName() ?? 'unknown'}`);
}

/**
 * Log at startup which Opus module prism-media uses (`@discordjs/opus` or
 * `opusscript`), so production logs show whether the opusscript decoder cap
 * applies before anyone speaks. prism loads the module with its first
 * stream, so a throwaway decoder is opened and closed to find out. Never
 * throws: a missing module is logged as a warning.
 */
export function logOpusBackend(): void {
  if (backendLogged) return;
  try {
    if (!opusBackendName()) {
      new prism.opus.Decoder({
        rate: AUDIO.SAMPLE_RATE,
        channels: 1,
        frameSize: 960,
      }).destroy();
    }
  } catch (error) {
    logger.warn(
      `No Opus module could be loaded; voice audio cannot be decoded: ${getErrorMessage(error)}`
    );
    return;
  }
  logOpusBackendOnce();
}

function reportDecodeError(userId: string, error: unknown): void {
  const message = getErrorMessage(error);
  if (!message.includes(OPUS_HEAP_EXHAUSTED)) {
    logger.debug(`Audio decode error for user ${userId}:`, message);
    return;
  }
  const now = Date.now();
  if (now - lastDecoderWarningAt < DECODER_WARNING_INTERVAL_MS) return;
  lastDecoderWarningAt = now;
  logger.warn(
    `Opus decoder ran out of memory with ${liveDecoders} live decoders; ` +
      'speakers beyond this are not recorded. Installing @discordjs/opus ' +
      'lifts the opusscript limit.'
  );
}

/**
 * Work that must happen while the bot is still in the channel, such as
 * clearing the voice channel status it set (Discord accepts that only from
 * a member). Return undefined when there is nothing to do.
 */
export type BeforeDisconnectHook = (
  channelId: string
) => Promise<unknown> | undefined;

/** How long a disconnect waits for its before-disconnect hooks. */
export const BEFORE_DISCONNECT_TIMEOUT_MS = 2_000;

export interface ConnectOptions {
  /**
   * Decode and buffer what people say (the `/voice record` ring). Defaults to
   * true. Text-to-speech joins with `false` where the server has opted out of
   * buffering, and the bot then also deafens itself so members can see it is
   * not listening.
   */
  receive?: boolean;
}

/**
 * Voice connection manager
 */
export class VoiceConnectionManager {
  private connections: Map<string, VoiceConnectionInfo> = new Map();
  private activeStreams: Map<string, Set<Readable>> = new Map();
  /** One audio player per connection, used by text-to-speech playback. */
  private players: Map<string, AudioPlayer> = new Map();
  private readonly disconnectListeners = new Set<(channelId: string) => void>();
  private readonly beforeDisconnectHooks = new Set<BeforeDisconnectHook>();
  /** In-flight connect promises keyed by channel id (dedupe concurrent joins). */
  private readonly connecting = new Map<
    string,
    Promise<VoiceConnection | null>
  >();
  /**
   * Guild ids with an in-flight connect. Discord allows one voice connection
   * per guild; tracking this prevents a second channel join from reusing the
   * live VoiceConnection under a different channelId (mix-ring cross-talk).
   */
  private readonly connectingGuilds = new Map<string, string>();
  private maxConnectionsValue: number | null = null;

  /** Read on use, not on import: constructing this must not touch config. */
  private get maxConnections(): number {
    this.maxConnectionsValue ??= env.MAX_CONCURRENT_VC_CONNECTIONS;
    return this.maxConnectionsValue;
  }

  /**
   * Check if bot has permission to connect to voice channel
   */
  private async checkPermissions(
    channel: VoiceChannel | StageChannel
  ): Promise<boolean> {
    const me = channel.guild.members.me;
    if (!me) return false;

    const permissions = channel.permissionsFor(me);
    if (!permissions) return false;

    return permissions.has(PermissionFlagsBits.Connect);
  }

  /**
   * True when this guild already has a tracked or in-flight connection on a
   * different channel. `@discordjs/voice` keys connections by guildId and will
   * move/reuse the existing VoiceConnection — registering it again under a
   * second channelId wires both mix rings to the same receiver.
   */
  private hasOtherChannelInGuild(
    guildId: string,
    channelId: string
  ): string | undefined {
    for (const [otherChannelId, info] of this.connections) {
      if (info.guildId === guildId && otherChannelId !== channelId) {
        return otherChannelId;
      }
    }
    const inFlightChannelId = this.connectingGuilds.get(guildId);
    if (inFlightChannelId && inFlightChannelId !== channelId) {
      return inFlightChannelId;
    }
    return undefined;
  }

  /**
   * Established connections plus in-flight joins that have not landed yet.
   * Channels present in both maps (between `connections.set` and `connecting`
   * cleanup) are counted once so max>1 is not under-admitted.
   */
  private usageCount(excludeChannelId?: string): number {
    let inFlightOnly = 0;
    for (const channelId of this.connecting.keys()) {
      if (channelId === excludeChannelId) continue;
      if (!this.connections.has(channelId)) {
        inFlightOnly++;
      }
    }
    return this.connections.size + inFlightOnly;
  }

  /**
   * Connect to a voice channel.
   * Concurrent callers for the same channel share one in-flight join.
   * Limit checks include in-flight connects to avoid TOCTOU bypass.
   * At most one channel per guild is allowed (Discord voice constraint).
   */
  async connect(
    guild: Guild,
    channel: VoiceChannel | StageChannel,
    options: ConnectOptions = {}
  ): Promise<VoiceConnection | null> {
    const channelId = channel.id;
    const guildId = guild.id;

    const existing = this.connections.get(channelId);
    if (existing) {
      logger.debug(`Already connected/connecting to channel ${channelId}`);
      return existing.connection;
    }

    const otherChannelId = this.hasOtherChannelInGuild(guildId, channelId);
    if (otherChannelId) {
      logger.warn(
        `Already connected in guild ${guildId} (channel ${otherChannelId}). Cannot connect to ${channelId} — Discord allows one voice connection per guild.`
      );
      return null;
    }

    const inFlight = this.connecting.get(channelId);
    if (inFlight) {
      return inFlight;
    }

    // Reserve before any await (JS is single-threaded until await).
    if (this.usageCount() >= this.maxConnections) {
      logger.warn(
        `Connection limit reached (${this.maxConnections}). Cannot connect to channel ${channelId}`
      );
      return null;
    }

    const connectPromise = this.connectInternal(
      guild,
      channel,
      options.receive !== false
    );
    this.connecting.set(channelId, connectPromise);
    this.connectingGuilds.set(guildId, channelId);
    try {
      return await connectPromise;
    } finally {
      this.connecting.delete(channelId);
      if (this.connectingGuilds.get(guildId) === channelId) {
        this.connectingGuilds.delete(guildId);
      }
    }
  }

  private async connectInternal(
    guild: Guild,
    channel: VoiceChannel | StageChannel,
    receive: boolean
  ): Promise<VoiceConnection | null> {
    const channelId = channel.id;
    const guildId = guild.id;

    const existing = this.connections.get(channelId);
    if (existing) {
      return existing.connection;
    }

    const hasPermission = await this.checkPermissions(channel);
    if (!hasPermission) {
      logger.warn(
        `Bot does not have permission to connect to channel ${channelId}`
      );
      return null;
    }

    // Another connect may have won while we awaited permissions
    const raced = this.connections.get(channelId);
    if (raced) {
      return raced.connection;
    }

    const otherChannelId = this.hasOtherChannelInGuild(guildId, channelId);
    if (otherChannelId) {
      logger.warn(
        `Already connected in guild ${guildId} (channel ${otherChannelId}). Cannot connect to ${channelId} — Discord allows one voice connection per guild.`
      );
      return null;
    }

    // Other usage = established + other in-flight (exclude this reservation)
    if (this.usageCount(channelId) >= this.maxConnections) {
      logger.warn(
        `Connection limit reached (${this.maxConnections}). Cannot connect to channel ${channelId}`
      );
      return null;
    }

    try {
      // Create voice connection
      // selfDeaf: false is required to receive audio for recording; a
      // connection that will not record deafens itself so that is visible.
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: !receive,
        selfMute: true,
      });

      // Create audio player
      const player = createAudioPlayer();

      connection.subscribe(player);
      this.players.set(channelId, player);

      // Track active streams for cleanup on disconnect
      this.activeStreams.set(channelId, new Set());

      // Drop any ring left over from a previous session on this channel. The
      // replacement is allocated by the first audio chunk (see below), not
      // here: a channel nobody speaks in must not hold a buffer.
      channelMixRingManager.remove(channelId);

      // Track subscribed users to avoid duplicate subscriptions
      const subscribedUsers = new Set<string>();

      // Set up audio reception for all users. Read the flag on every event
      // rather than capturing `receive`: enableReceive() can turn a deafened
      // text-to-speech join into a listening one without reconnecting.
      connection.receiver.speaking.on('start', (userId) => {
        if (this.connections.get(channelId)?.receiving === false) return;
        if (subscribedUsers.has(userId)) return;
        subscribedUsers.add(userId);
        logger.debug(
          `Speaking started for user ${userId} in channel ${channelId}`
        );

        const opusStream = connection.receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1500,
          },
        });

        // Mono straight from the decoder: libopus downmixes for free, which
        // saves a JS downmix per chunk and lets more decoders fit in the
        // opusscript heap than stereo would.
        const decoder = new prism.opus.Decoder({
          rate: AUDIO.SAMPLE_RATE,
          channels: 1,
          frameSize: 960,
        });
        liveDecoders++;
        logOpusBackendOnce();

        const pcmStream = opusStream.pipe(decoder);

        const streams = this.activeStreams.get(channelId);
        if (streams) {
          streams.add(opusStream as unknown as Readable);
          streams.add(pcmStream as unknown as Readable);
        }
        // Type assertions: prism Decoder and discord/voice produce Node-like streams
        // but their types don't extend Readable; runtime behavior is compatible.

        let cleanedUp = false;
        const cleanup = () => {
          subscribedUsers.delete(userId);
          if (!cleanedUp) {
            cleanedUp = true;
            liveDecoders--;
          }
          if (!opusStream.destroyed) opusStream.destroy();
          if (!pcmStream.destroyed) pcmStream.destroy();
          if (streams) {
            streams.delete(opusStream as unknown as Readable);
            streams.delete(pcmStream as unknown as Readable);
          }
        };

        // One placer per talk spurt: frames are laid end to end instead of
        // at their (jittery) arrival times. See ChunkPlacer.
        const placer = new ChunkPlacer();
        let chunkCount = 0;
        pcmStream.on('data', (chunk: Buffer) => {
          if (!this.connections.has(channelId)) return;
          chunkCount++;
          if (chunkCount === 1) {
            logger.debug(
              `First audio chunk received from user ${userId} (${chunk.length} bytes)`
            );
          }

          // Allocated here rather than on connect: the ring costs ~55MB at the
          // default buffer length, and a channel where nobody ever speaks
          // should not pay it. The first chunk also sets the ring's epoch, so
          // the timeline starts at real audio instead of at join time.
          const ring = channelMixRingManager.getOrCreate(channelId);
          const samples = chunk.length >> 1;
          const start = placer.place(ring.globalIndexAt(Date.now()), samples);
          if (start === null) return; // catching up after running ahead
          ring.addMonoPcmInt16At(chunk, start);
        });

        pcmStream.on('error', (error) => {
          reportDecodeError(userId, error);
          cleanup();
        });

        opusStream.on('error', (error) => {
          logger.debug(
            `Audio stream error for user ${userId}:`,
            getErrorMessage(error)
          );
          cleanup();
        });

        pcmStream.on('close', () => {
          cleanup();
        });
      });

      connection.on('stateChange', (oldState, newState) => {
        logger.debug(
          `Voice connection state: ${oldState.status} -> ${newState.status}`
        );
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Reconnecting to a new channel - ignore disconnect
        } catch {
          // Real disconnect - clean up only if this connection is still tracked.
          // A replacement join for the same channel must not be destroyed by a
          // stale handler from the previous VoiceConnection instance.
          const current = this.connections.get(channelId);
          if (current?.connection !== connection) {
            return;
          }
          this.destroyStreamsForChannel(channelId);
          this.releasePlayer(channelId);
          connection.destroy();
          this.connections.delete(channelId);
          channelMixRingManager.remove(channelId);
          logger.info(`Disconnected from voice channel ${channelId}`);
          this.notifyDisconnect(channelId);
        }
      });

      connection.on(VoiceConnectionStatus.Ready, () => {
        const connInfo = this.connections.get(channelId);
        if (connInfo?.connection !== connection) {
          return;
        }
        connInfo.state = VoiceConnectionState.Connected;
        connInfo.connectedAt = Date.now();
        logger.info(`Connected to voice channel ${channelId}`);
      });

      // Store connection info
      const info: VoiceConnectionInfo = {
        connection,
        state: VoiceConnectionState.Connecting,
        channelId,
        guildId: guild.id,
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        receiving: receive,
      };

      this.connections.set(channelId, info);

      logger.info(
        `Connecting to voice channel ${channel.name} (${channelId}) in guild ${guild.name}`
      );

      return connection;
    } catch (error) {
      logger.error(
        `Failed to connect to voice channel ${channelId}:`,
        getErrorMessage(error)
      );
      return null;
    }
  }

  /**
   * Disconnect from a voice channel. With `expected`, only when that is still
   * the connection tracked there: a caller cleaning up its own join must not
   * tear down a replacement someone else made in the meantime.
   */
  async disconnect(
    channelId: string,
    expected?: VoiceConnection
  ): Promise<void> {
    const info = this.connections.get(channelId);
    if (!info) return;
    if (expected && info.connection !== expected) {
      logger.debug(
        `Not disconnecting ${channelId}: its connection was replaced`
      );
      return;
    }

    const before = this.runBeforeDisconnect(channelId);
    if (before) {
      await before;
      // Another disconnect (or a kick) finished the job while we waited.
      if (this.connections.get(channelId) !== info) return;
    }

    try {
      // Destroy all active audio streams for this channel
      this.destroyStreamsForChannel(channelId);
      this.releasePlayer(channelId);

      info.connection.destroy();
      this.connections.delete(channelId);

      channelMixRingManager.remove(channelId);

      logger.info(`Disconnected from voice channel ${channelId}`);
      this.notifyDisconnect(channelId);
    } catch (error) {
      logger.error(
        `Error disconnecting from channel ${channelId}:`,
        getErrorMessage(error)
      );
      this.destroyStreamsForChannel(channelId);
      this.releasePlayer(channelId);
      this.connections.delete(channelId);
      channelMixRingManager.remove(channelId);
      this.notifyDisconnect(channelId);
    }
  }

  /**
   * Run `hook` before every disconnect this manager makes, while the bot is
   * still in the channel. The disconnect waits for it, but never longer than
   * `BEFORE_DISCONNECT_TIMEOUT_MS`. Not run when Discord already dropped the
   * connection (a kick or network loss). Returns an unsubscribe.
   */
  onBeforeDisconnect(hook: BeforeDisconnectHook): () => void {
    this.beforeDisconnectHooks.add(hook);
    return () => this.beforeDisconnectHooks.delete(hook);
  }

  /** Null when no hook has work to do, so most disconnects stay synchronous. */
  private runBeforeDisconnect(channelId: string): Promise<void> | null {
    const pending: Promise<unknown>[] = [];
    for (const hook of this.beforeDisconnectHooks) {
      try {
        const result = hook(channelId);
        if (result) {
          pending.push(
            result.catch((error: unknown) => {
              logger.debug(
                `Before-disconnect hook failed for ${channelId}:`,
                getErrorMessage(error)
              );
            })
          );
        }
      } catch (error) {
        logger.debug(
          `Before-disconnect hook failed for ${channelId}:`,
          getErrorMessage(error)
        );
      }
    }
    if (pending.length === 0) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BEFORE_DISCONNECT_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([
      Promise.all(pending).then(() => undefined),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * Run `listener` whenever a tracked connection goes away, however it went
   * (explicit disconnect, kick, network loss). Returns an unsubscribe.
   */
  onDisconnect(listener: (channelId: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private notifyDisconnect(channelId: string): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener(channelId);
      } catch (error) {
        logger.error(
          `Disconnect listener failed for ${channelId}:`,
          getErrorMessage(error)
        );
      }
    }
  }

  private releasePlayer(channelId: string): void {
    const player = this.players.get(channelId);
    if (!player) return;
    try {
      player.stop(true);
    } catch {
      // Player may already be stopped
    }
    this.players.delete(channelId);
  }

  /**
   * The audio player attached to a channel's connection, if connected.
   */
  getPlayer(channelId: string): AudioPlayer | undefined {
    return this.players.get(channelId);
  }

  /**
   * Toggle the bot's self-mute without reconnecting. Text-to-speech unmutes
   * while it is reading and mutes again afterwards, so the icon in the member
   * list matches whether the bot can be heard.
   */
  setSelfMute(channelId: string, muted: boolean): boolean {
    return this.updateVoiceState(channelId, { selfMute: muted });
  }

  /**
   * Start listening on a connection that joined deafened for text-to-speech
   * (`receive: false`), in place: reconnecting would end the reading session
   * and race the bot's own leave/join voice-state events. False when the
   * channel is not connected or is already listening.
   */
  enableReceive(channelId: string): boolean {
    const info = this.connections.get(channelId);
    if (!info || info.receiving !== false) return false;
    info.receiving = true;
    this.updateVoiceState(channelId, { selfDeaf: false });
    logger.info(`Started receiving audio in voice channel ${channelId}`);
    return true;
  }

  /** Change self-mute or self-deaf, keeping whatever is not given. */
  private updateVoiceState(
    channelId: string,
    change: { selfMute?: boolean; selfDeaf?: boolean }
  ): boolean {
    const info = this.connections.get(channelId);
    if (!info) return false;
    const { connection } = info;
    // Deafened exactly when not receiving: joinConfig can be rewritten by a
    // late voice-state update from before enableReceive(), which would
    // deafen a listening connection again.
    const apply = () =>
      connection.rejoin({
        channelId,
        selfDeaf: change.selfDeaf ?? info.receiving === false,
        selfMute: change.selfMute ?? connection.joinConfig.selfMute,
      });

    // rejoin() on a connection that is still handshaking restarts the
    // signalling, so wait for it to be ready rather than interrupting it.
    if (connection.state.status === VoiceConnectionStatus.Ready) {
      return apply();
    }
    connection.once(VoiceConnectionStatus.Ready, apply);
    return true;
  }

  /**
   * Wait for a channel's connection to finish connecting, and return it.
   * Null when nothing is tracked, it does not become ready in time, or it is
   * destroyed or replaced while waiting - a destroyed connection never
   * reaches Ready, so waiting for it would only run out the clock.
   */
  async waitUntilReady(
    channelId: string,
    timeoutMs: number
  ): Promise<VoiceConnection | null> {
    const info = this.connections.get(channelId);
    if (!info) return null;
    const { connection } = info;

    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, stop.signal),
        entersState(connection, VoiceConnectionStatus.Destroyed, stop.signal)
          // A destroyed connection is a failed wait, not a finished one.
          .then(() => Promise.reject(new Error('destroyed'))),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      stop.abort();
    }
    return this.connections.get(channelId)?.connection === connection
      ? connection
      : null;
  }

  private destroyStreamsForChannel(channelId: string): void {
    const streams = this.activeStreams.get(channelId);
    if (streams) {
      for (const stream of streams) {
        try {
          if (!stream.destroyed) {
            stream.destroy();
          }
        } catch {
          // Stream may already be destroyed
        }
      }
      this.activeStreams.delete(channelId);
    }
  }

  /**
   * Get connection info
   */
  getConnection(channelId: string): VoiceConnectionInfo | undefined {
    return this.connections.get(channelId);
  }

  /**
   * Channel the bot is connected to in this guild, if any. Discord allows one
   * voice connection per guild, so this is the channel that keeps every
   * other channel of the guild from being joined.
   */
  getConnectedChannelInGuild(guildId: string): string | undefined {
    for (const info of this.connections.values()) {
      if (info.guildId === guildId) {
        return info.channelId;
      }
    }
    return undefined;
  }

  /**
   * Get all active connections
   */
  getAllConnections(): Map<string, VoiceConnectionInfo> {
    return new Map(this.connections);
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Check if at connection limit
   */
  isAtLimit(): boolean {
    return this.connections.size >= this.maxConnections;
  }

  /**
   * Shed connections when memory runs short: those holding a mix ring first
   * (that is where the memory is), then other listening connections, then
   * text-to-speech-only joins, which hold almost nothing - dropping one of
   * those would end a reading session and free no memory. Oldest first
   * within each group.
   */
  async disconnectOldest(count: number): Promise<void> {
    const sheddingOrder = (channelId: string, info: VoiceConnectionInfo) => {
      if (channelMixRingManager.has(channelId)) return 0;
      return info.receiving === false ? 2 : 1;
    };
    const sorted = Array.from(this.connections.entries()).sort(
      (a, b) =>
        sheddingOrder(a[0], a[1]) - sheddingOrder(b[0], b[1]) ||
        a[1].connectedAt - b[1].connectedAt
    );

    for (let i = 0; i < Math.min(count, sorted.length); i++) {
      const [channelId] = sorted[i];
      await this.disconnect(channelId);
    }
  }

  /**
   * Update last activity timestamp
   */
  updateActivity(channelId: string): void {
    const info = this.connections.get(channelId);
    if (info) {
      info.lastActivity = Date.now();
    }
  }
}

/**
 * Singleton instance
 */
export const connectionManager = new VoiceConnectionManager();
