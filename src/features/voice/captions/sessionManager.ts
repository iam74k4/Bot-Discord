import { escapeMarkdown } from 'discord.js';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import type { AudioTap } from '../recording/connectionManager.js';
import { captionConsentRepository } from '../repositories/captionConsentRepository.js';
import {
  type ScheduledJob,
  SynthesisScheduler,
} from '../tts/synthesisScheduler.js';
import { downsampleTo16k, encodeWav, rmsDbfs } from './audio.js';
import { CaptionPoster } from './captionPoster.js';
import { cleanTranscript } from './transcriptFilter.js';
import { type Utterance, UtteranceCollector } from './utterances.js';
import {
  getWhisperClient,
  type Transcript,
  WhisperError,
} from './whisperClient.js';

/**
 * Caption sessions: which voice channel is being captioned, and the path
 * from a speaker's audio to a line in that channel's chat.
 *
 * Audio arrives through the connection manager's audio tap, speaker by
 * speaker. Only members who agreed to captions in that server are ever
 * collected; everyone else's audio is ignored at the door. Each speaker's
 * audio is cut into utterances (see UtteranceCollector), near-silent ones
 * are skipped, and the rest go to the Whisper engine through one scheduler
 * shared by every session - one request at a time, guilds taking turns, the
 * same arrangement that keeps the shared VOICEVOX engine fair. Lines come
 * back in the order they were spoken and are posted in batches under
 * Discord's rate limit (see CaptionPoster).
 *
 * Captions are only useful while the conversation is still going on, so the
 * backlog is held down: a session keeps at most `MAX_WAITING` utterances
 * waiting for the engine, dropping the oldest, and one that waited longer
 * than `MAX_WAIT_MS` is dropped rather than transcribed.
 */

export interface CaptionSessionInfo {
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  startedAt: number;
}

export interface CaptionSessionParams {
  guildId: string;
  voiceChannelId: string;
  startedBy: string;
  /** Post one message to the voice channel's chat. */
  post(content: string): Promise<void>;
  /** A speaker's name as the caption line shows it. */
  nameOf(userId: string): string;
  /** The engine failed several times in a row; called once per outage. */
  onEngineTrouble?(): void;
}

export interface CaptionEngineDeps {
  /** Transcribe one 16 kHz mono WAV file. */
  transcribe(wav: Buffer): Promise<Transcript>;
  hasConsented(guildId: string, userId: string): boolean;
}

/**
 * Quieter utterances are not sent at all: Whisper turns near-silence into
 * confident nonsense, and transcribing it costs the engine a turn.
 */
export const MIN_SPEECH_DBFS = -50;
/** Utterances a session may have waiting for the engine. */
export const MAX_WAITING = 6;
/** An utterance still waiting this long is dropped instead of transcribed. */
export const MAX_WAIT_MS = 20_000;
/** Consecutive engine failures before the channel is told. */
export const ENGINE_TROUBLE_AFTER = 3;

/** One caption line: the speaker in bold, then what they said. */
export function formatCaption(name: string, text: string): string {
  return `**${escapeMarkdown(name)}**: ${escapeMarkdown(text)}`;
}

interface Pending {
  userId: string;
  job: ScheduledJob<Transcript | null>;
}

interface Session {
  /** Scheduler key; never reused, so a restarted session gets nothing old. */
  key: string;
  info: CaptionSessionInfo;
  params: CaptionSessionParams;
  poster: CaptionPoster;
  collectors: Map<string, UtteranceCollector>;
  pending: Pending[];
  stopped: boolean;
  failures: number;
  troubleReported: boolean;
}

export class CaptionSessionManager implements AudioTap {
  /** Keyed by voice channel id; at most one per guild. */
  private readonly sessions = new Map<string, Session>();
  private sessionCount = 0;

  constructor(
    private readonly deps: CaptionEngineDeps,
    private readonly now: () => number = Date.now,
    private readonly scheduler: SynthesisScheduler = new SynthesisScheduler()
  ) {}

  /**
   * Start captioning a voice channel. A session elsewhere in the guild is
   * stopped: Discord allows the bot one voice channel per guild. Starting
   * where a session already runs keeps that session.
   */
  start(params: CaptionSessionParams): CaptionSessionInfo {
    for (const session of [...this.sessions.values()]) {
      if (
        session.info.guildId === params.guildId &&
        session.info.voiceChannelId !== params.voiceChannelId
      ) {
        this.stop(session.info.voiceChannelId);
      }
    }

    const existing = this.sessions.get(params.voiceChannelId);
    if (existing) return existing.info;

    const session: Session = {
      key: `captions:${params.voiceChannelId}:${++this.sessionCount}`,
      info: {
        guildId: params.guildId,
        voiceChannelId: params.voiceChannelId,
        startedBy: params.startedBy,
        startedAt: this.now(),
      },
      params,
      poster: new CaptionPoster((content) => params.post(content)),
      collectors: new Map(),
      pending: [],
      stopped: false,
      failures: 0,
      troubleReported: false,
    };
    this.sessions.set(params.voiceChannelId, session);
    return session.info;
  }

  /** End a session: nothing more is transcribed or posted. */
  stop(voiceChannelId: string): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session) return false;

    session.stopped = true;
    session.poster.stop();
    session.collectors.clear();
    for (const { job } of session.pending) job.cancel();
    session.pending = [];
    this.sessions.delete(voiceChannelId);
    return true;
  }

  /** The voice connection went away; the session goes with it. */
  handleDisconnect(voiceChannelId: string): void {
    if (this.stop(voiceChannelId)) {
      logger.info(
        `Caption session in ${voiceChannelId} ended with the connection`
      );
    }
  }

  stopAll(): void {
    for (const voiceChannelId of [...this.sessions.keys()]) {
      this.stop(voiceChannelId);
    }
  }

  get(voiceChannelId: string): CaptionSessionInfo | undefined {
    return this.sessions.get(voiceChannelId)?.info;
  }

  getForGuild(guildId: string): CaptionSessionInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.info.guildId === guildId) return session.info;
    }
    return undefined;
  }

  /**
   * A member withdrew consent: drop what was collected of them and whatever
   * of theirs is still waiting for (or at) the engine, so nothing they said
   * before withdrawing is posted after it.
   */
  forgetUser(guildId: string, userId: string): void {
    for (const session of this.sessions.values()) {
      if (session.info.guildId !== guildId) continue;
      session.collectors.delete(userId);
      session.pending = session.pending.filter((entry) => {
        if (entry.userId !== userId) return true;
        entry.job.cancel();
        return false;
      });
    }
  }

  onAudio(channelId: string, userId: string, pcm: Buffer, now: number): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    if (!this.deps.hasConsented(session.info.guildId, userId)) {
      // Asked on every chunk: consent withdrawn mid-sentence ends collection
      // there, and what was already collected is dropped.
      session.collectors.delete(userId);
      return;
    }

    let collector = session.collectors.get(userId);
    if (!collector) {
      collector = new UtteranceCollector(userId, (utterance) =>
        this.transcribe(session, utterance)
      );
      session.collectors.set(userId, collector);
    }
    collector.push(pcm, now);
  }

  onSpeechEnd(channelId: string, userId: string): void {
    const session = this.sessions.get(channelId);
    const collector = session?.collectors.get(userId);
    if (!session || !collector) return;
    session.collectors.delete(userId);
    collector.end();
  }

  private transcribe(session: Session, utterance: Utterance): void {
    if (session.stopped) return;
    const pcm = downsampleTo16k(utterance.pcm);
    if (rmsDbfs(pcm) < MIN_SPEECH_DBFS) return;

    const waiting = session.pending.filter(
      (entry) => entry.job.state === 'queued'
    );
    if (waiting.length >= MAX_WAITING) {
      const [oldest] = waiting;
      oldest.job.cancel();
      session.pending = session.pending.filter((entry) => entry !== oldest);
    }

    const queuedAt = this.now();
    const job = this.scheduler.submit(session.key, async () => {
      if (this.now() - queuedAt > MAX_WAIT_MS) return null;
      return this.deps.transcribe(encodeWav(pcm));
    });
    const entry: Pending = { userId: utterance.userId, job };
    session.pending.push(entry);

    job.promise.then(
      (transcript) => {
        this.settle(session, entry);
        if (!transcript) return;
        session.failures = 0;
        session.troubleReported = false;
        this.post(session, utterance.userId, transcript);
      },
      (error: unknown) => {
        this.settle(session, entry);
        this.reportFailure(session, error);
      }
    );
  }

  private settle(session: Session, entry: Pending): void {
    session.pending = session.pending.filter((other) => other !== entry);
  }

  private post(session: Session, userId: string, transcript: Transcript): void {
    if (session.stopped) return;
    // Consent may have been withdrawn while the engine was working.
    if (!this.deps.hasConsented(session.info.guildId, userId)) return;
    const text = cleanTranscript(transcript);
    if (!text) return;
    session.poster.add(formatCaption(session.params.nameOf(userId), text));
  }

  private reportFailure(session: Session, error: unknown): void {
    if (session.stopped) return;
    session.failures++;
    logger.debug(
      `Caption transcription failed in ${session.info.voiceChannelId}: ${getErrorMessage(error)}`
    );
    if (session.failures < ENGINE_TROUBLE_AFTER || session.troubleReported) {
      return;
    }
    session.troubleReported = true;
    logger.warn(
      `Captions in ${session.info.voiceChannelId} keep failing: ${getErrorMessage(error)}`
    );
    try {
      session.params.onEngineTrouble?.();
    } catch (callbackError) {
      logger.debug(
        `Caption trouble notice failed: ${getErrorMessage(callbackError)}`
      );
    }
  }
}

export const captionSessions = new CaptionSessionManager({
  transcribe: (wav) => {
    const client = getWhisperClient();
    if (!client) {
      return Promise.reject(new WhisperError('WHISPER_URL is not set'));
    }
    return client.transcribe(wav);
  },
  hasConsented: (guildId, userId) =>
    captionConsentRepository.hasConsented(guildId, userId),
});
