import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
} from '@discordjs/voice';
import { PassThrough } from 'stream';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { connectionManager } from '../recording/connectionManager.js';
import { getVoicevoxClient, VoicevoxError } from './voicevoxClient.js';
import { playbackDurationMs } from './wav.js';

/**
 * Text-to-speech sessions: which voice channel is being read to, from which
 * text channels, and the queue of lines waiting to be spoken.
 *
 * Lines are synthesized a little ahead of playback (the next one renders while
 * the current one plays) so a busy chat does not wait on the engine between
 * every message, and the queue is capped so a flood of messages cannot leave
 * the bot reading minutes behind the conversation.
 */

export interface SpeechRequest {
  authorId: string;
  /** Display name already normalized for speech; '' to never announce it. */
  authorName: string;
  /** Message text already normalized for speech. */
  text: string;
  speakerId: number;
  speed: number;
}

export interface TtsSessionInfo {
  guildId: string;
  voiceChannelId: string;
  /** Text channels being read; always includes the voice channel's own chat. */
  textChannelIds: ReadonlySet<string>;
  startedBy: string;
  startedAt: number;
}

export interface TtsPlaybackDeps {
  getPlayer(voiceChannelId: string): AudioPlayer | undefined;
  setSelfMute(voiceChannelId: string, muted: boolean): boolean;
  synthesize(text: string, speakerId: number, speed: number): Promise<Buffer>;
  /** Resolves when the clip has finished or was stopped. */
  play(player: AudioPlayer, pcm: Buffer): Promise<void>;
}

/** Lines waiting beyond this are dropped oldest-first. */
export const MAX_QUEUE_LENGTH = 10;
/** Lines rendered ahead of playback. */
const PREFETCH_COUNT = 2;
/** Re-announce a speaker who has been quiet this long. */
const NAME_REANNOUNCE_MS = 60_000;

interface QueueItem {
  request: SpeechRequest;
  spoken: string;
  audio?: Promise<Buffer | null>;
  /** Skipped while still being synthesized; never played. */
  skipped?: boolean;
}

interface Session {
  info: TtsSessionInfo & { textChannelIds: Set<string> };
  queue: QueueItem[];
  playing: boolean;
  current: QueueItem | null;
  stopped: boolean;
  lastAuthorId: string | null;
  lastSpokenAt: number;
}

export class TtsSessionManager {
  /** Keyed by voice channel id; at most one per guild. */
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly deps: TtsPlaybackDeps,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Start reading into a voice channel, or add a text channel to the session
   * already running there. A session elsewhere in the guild is stopped:
   * Discord allows the bot one voice channel per guild.
   */
  start(params: {
    guildId: string;
    voiceChannelId: string;
    textChannelId: string;
    startedBy: string;
  }): TtsSessionInfo {
    for (const session of [...this.sessions.values()]) {
      if (
        session.info.guildId === params.guildId &&
        session.info.voiceChannelId !== params.voiceChannelId
      ) {
        this.stop(session.info.voiceChannelId);
      }
    }

    const existing = this.sessions.get(params.voiceChannelId);
    if (existing) {
      existing.info.textChannelIds.add(params.textChannelId);
      return existing.info;
    }

    const session: Session = {
      info: {
        guildId: params.guildId,
        voiceChannelId: params.voiceChannelId,
        textChannelIds: new Set([params.voiceChannelId, params.textChannelId]),
        startedBy: params.startedBy,
        startedAt: this.now(),
      },
      queue: [],
      playing: false,
      current: null,
      stopped: false,
      lastAuthorId: null,
      lastSpokenAt: 0,
    };
    this.sessions.set(params.voiceChannelId, session);

    // Muted while idle so the member list shows the bot cannot be heard.
    this.deps.setSelfMute(params.voiceChannelId, false);
    return session.info;
  }

  /**
   * End a session. `restoreMute` is false when the connection is already
   * gone and there is nobody to show the mute icon to.
   */
  stop(voiceChannelId: string, { restoreMute = true } = {}): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session) return false;

    session.stopped = true;
    session.queue = [];
    this.sessions.delete(voiceChannelId);

    this.deps.getPlayer(voiceChannelId)?.stop(true);
    if (restoreMute) {
      this.deps.setSelfMute(voiceChannelId, true);
    }
    return true;
  }

  /** The voice connection went away; drop the session without touching it. */
  handleDisconnect(voiceChannelId: string): void {
    if (this.stop(voiceChannelId, { restoreMute: false })) {
      logger.info(`TTS session in ${voiceChannelId} ended with the connection`);
    }
  }

  stopAll(): void {
    for (const voiceChannelId of [...this.sessions.keys()]) {
      this.stop(voiceChannelId, { restoreMute: false });
    }
  }

  get(voiceChannelId: string): TtsSessionInfo | undefined {
    return this.sessions.get(voiceChannelId)?.info;
  }

  getForGuild(guildId: string): TtsSessionInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.info.guildId === guildId) return session.info;
    }
    return undefined;
  }

  /** The session a message posted in this text channel should be read into. */
  findForTextChannel(
    guildId: string,
    textChannelId: string
  ): TtsSessionInfo | undefined {
    const session = this.getForGuild(guildId);
    return session?.textChannelIds.has(textChannelId) ? session : undefined;
  }

  /** Lines waiting to be spoken, not counting the one playing. */
  queueLength(voiceChannelId: string): number {
    return this.sessions.get(voiceChannelId)?.queue.length ?? 0;
  }

  /**
   * Queue a line. The speaker's name is prepended when the speaker changes or
   * has been quiet for a while, so listeners can tell who is talking even
   * when two people share a voice.
   */
  enqueue(voiceChannelId: string, request: SpeechRequest): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session) return false;

    const now = this.now();
    const announce =
      request.authorName !== '' &&
      (request.authorId !== session.lastAuthorId ||
        now - session.lastSpokenAt > NAME_REANNOUNCE_MS);
    session.lastAuthorId = request.authorId;
    session.lastSpokenAt = now;

    const spoken = announce
      ? `${request.authorName}、${request.text}`
      : request.text;

    if (session.queue.length >= MAX_QUEUE_LENGTH) {
      session.queue.shift();
      logger.debug(`TTS queue full in ${voiceChannelId}; dropped oldest line`);
    }
    session.queue.push({ request, spoken });

    this.pump(session).catch((error: unknown) => {
      logger.error('TTS queue stopped:', getErrorMessage(error));
    });
    return true;
  }

  /** Stop the line being spoken (or about to be); the queue carries on. */
  skip(voiceChannelId: string): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session?.current) return false;
    session.current.skipped = true;
    this.deps.getPlayer(voiceChannelId)?.stop(true);
    return true;
  }

  private prefetch(session: Session): void {
    for (const item of session.queue.slice(0, PREFETCH_COUNT)) {
      if (item.audio) continue;
      const { speakerId, speed } = item.request;
      item.audio = this.deps
        .synthesize(item.spoken, speakerId, speed)
        .catch((error: unknown) => {
          logger.warn(`TTS synthesis failed: ${getErrorMessage(error)}`);
          return null;
        });
    }
  }

  private async pump(session: Session): Promise<void> {
    if (session.playing) {
      this.prefetch(session);
      return;
    }
    session.playing = true;

    try {
      while (!session.stopped && session.queue.length > 0) {
        this.prefetch(session);
        const item = session.queue.shift()!;
        session.current = item;
        const pcm = await item.audio;
        // Render the next line while this one plays.
        this.prefetch(session);

        if (session.stopped) break;
        if (item.skipped || !pcm || pcm.length === 0) continue;

        const player = this.deps.getPlayer(session.info.voiceChannelId);
        if (!player) {
          this.stop(session.info.voiceChannelId, { restoreMute: false });
          break;
        }
        try {
          await this.deps.play(player, pcm);
        } catch (error) {
          // One clip that cannot play must not strand the lines behind it.
          logger.warn(`TTS playback failed: ${getErrorMessage(error)}`);
        }
      }
    } finally {
      session.playing = false;
      session.current = null;
    }
  }
}

/**
 * Play 48 kHz stereo s16le PCM and resolve when it ends, is skipped, or
 * errors. A timeout slightly past the clip length guards against a player
 * that never reports idle, so one stuck clip cannot stall the queue.
 */
export function playPcm(player: AudioPlayer, pcm: Buffer): Promise<void> {
  return new Promise((resolve) => {
    const stream = new PassThrough();
    stream.end(pcm);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });

    const finish = (): void => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Idle, finish);
      player.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      logger.debug(`TTS playback error: ${getErrorMessage(error)}`);
      finish();
    };
    const timeout = setTimeout(finish, playbackDurationMs(pcm) + 5_000);

    player.on(AudioPlayerStatus.Idle, finish);
    player.on('error', onError);
    player.play(resource);
  });
}

export const ttsSessions = new TtsSessionManager({
  getPlayer: (voiceChannelId) => connectionManager.getPlayer(voiceChannelId),
  setSelfMute: (voiceChannelId, muted) =>
    connectionManager.setSelfMute(voiceChannelId, muted),
  synthesize: (text, speakerId, speed) => {
    const client = getVoicevoxClient();
    if (!client) {
      return Promise.reject(new VoicevoxError('VOICEVOX_URL is not set'));
    }
    return client.synthesize(text, speakerId, speed);
  },
  play: playPcm,
});
