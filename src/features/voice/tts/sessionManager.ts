import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  StreamType,
  createAudioResource,
} from '@discordjs/voice';
import { Readable } from 'stream';
import { getErrorMessage, logger } from '../../../shared/utils/logger.js';
import { connectionManager } from '../recording/connectionManager.js';
import { NameAudioCache } from './nameAudioCache.js';
import {
  type JobToken,
  type ScheduledJob,
  SynthesisScheduler,
} from './synthesisScheduler.js';
import { joinSpeech } from './textNormalizer.js';
import {
  getVoicevoxClient,
  sliceQuery,
  type VoicevoxClient,
  VoicevoxError,
} from './voicevoxClient.js';
import { PLAYBACK_BYTES_PER_SECOND, playbackDurationMs } from './wav.js';

/**
 * Text-to-speech sessions: which voice channel is being read to, from which
 * text channels, and the queue of lines waiting to be spoken.
 *
 * Every request to the engine goes through one `SynthesisScheduler`, shared
 * by all sessions: one request at a time, guilds taking turns, and lines
 * that are dropped or skipped before they start never reach the engine.
 *
 * A line is rendered in slices from one audio_query and starts playing as
 * soon as its first slice is ready; the rest render while it plays. An
 * announced name is rendered on its own and cached, so it plays at once.
 * A couple of lines are handed to the engine ahead of playback, so a busy
 * chat does not wait on the engine between every message. The backlog is
 * held down by merging a speaker's consecutive lines, by dropping messages
 * that have waited too long, and by a hard cap on the queue, so a flood of
 * messages cannot leave the bot reading minutes behind the conversation.
 */

export interface SpeechRequest {
  authorId: string;
  /** Display name already normalized for speech; '' to never announce it. */
  authorName: string;
  /** Message text already normalized for speech. */
  text: string;
  speakerId: number;
  speed: number;
  /**
   * False for a line that must be heard on its own, such as a voice preview.
   * Otherwise a speaker's consecutive waiting lines are read as one.
   */
  mergeable?: boolean;
}

export interface TtsSessionInfo {
  guildId: string;
  voiceChannelId: string;
  /** Text channels being read; always includes the voice channel's own chat. */
  textChannelIds: ReadonlySet<string>;
  /**
   * VOICEVOX characters whose credit listeners have already been shown in
   * this session (see creditCharacter).
   */
  creditedCharacters: ReadonlySet<string>;
  startedBy: string;
  startedAt: number;
}

/** Renders one slice of a line. */
export type SliceRenderer = () => Promise<Buffer>;

export interface TtsPlaybackDeps {
  getPlayer(voiceChannelId: string): AudioPlayer | undefined;
  setSelfMute(voiceChannelId: string, muted: boolean): boolean;
  /**
   * Ask the engine how to say a line (one audio_query) and cut it into
   * slices that render one after another and play back to back.
   */
  prepare(
    text: string,
    speakerId: number,
    speed: number
  ): Promise<SliceRenderer[]>;
  /** A speaker's name as its own short utterance, as announced. */
  renderName(name: string, speakerId: number, speed: number): Promise<Buffer>;
  /** Load a voice model on the engine before its first line needs it. */
  initializeSpeaker?(speakerId: number): Promise<unknown>;
  /** Resolves when the line has finished or was stopped. */
  play(player: AudioPlayer, audio: AsyncIterable<Buffer>): Promise<void>;
}

/** Lines waiting beyond this are dropped, oldest not yet rendering first. */
export const MAX_QUEUE_LENGTH = 10;
/**
 * A message still waiting this long after it was posted is dropped instead
 * of being rendered: by then the conversation has moved on. Merging never
 * stretches this: each message of a merged line keeps its own age.
 */
export const MAX_LINE_AGE_MS = 25_000;
/** Lines handed to the engine ahead of playback. */
export const PREFETCH_COUNT = 2;
/** Re-announce a speaker who has been quiet this long. */
export const NAME_REANNOUNCE_MS = 60_000;
/** Scheduler key for warming up voice models. */
const WARM_UP_KEY = 'tts:warm-up';

const NO_AUDIO = Buffer.alloc(0);

interface LineRender {
  /**
   * The line's audio in play order: the announced name, then the text's
   * slices. Resolves null where the line ends early. Grows once the text's
   * audio_query has answered and its slices are known.
   */
  parts: Array<Promise<Buffer | null>>;
  /** Every engine job for this line, so it can be cancelled as a whole. */
  jobs: Array<ScheduledJob<unknown>>;
  /** The job that asks for the text's query and renders its first slice. */
  textJob?: ScheduledJob<unknown>;
  /** The text's first slice: the first part after the name. */
  textPart?: Promise<Buffer | null>;
  /** Set once the text's first slice has audio (true) or failed (false). */
  textRendered?: boolean;
  /** parts[0] is the announced name. */
  announced: boolean;
}

/** Who is speaking, and how: everything about a line but its text. */
type LineVoice = Omit<SpeechRequest, 'text'>;

interface Segment {
  text: string;
  postedAt: number;
}

interface QueueItem {
  voice: LineVoice;
  /** Its messages, oldest first: more than one once merged. */
  segments: Segment[];
  /** Set once the line has been handed to the engine. */
  render?: LineRender;
  /** Skipped, dropped or stopped: nothing more is rendered or played. */
  cancelled?: boolean;
}

interface Session {
  /** Scheduler key; never reused, so a restarted session gets nothing old. */
  key: string;
  info: TtsSessionInfo & {
    textChannelIds: Set<string>;
    creditedCharacters: Set<string>;
  };
  queue: QueueItem[];
  playing: boolean;
  current: QueueItem | null;
  stopped: boolean;
  lastAuthorId: string | null;
  lastSpokenAt: number;
}

function canMerge(waiting: LineVoice, next: SpeechRequest): boolean {
  return (
    waiting.mergeable !== false &&
    next.mergeable !== false &&
    waiting.authorId === next.authorId &&
    waiting.authorName === next.authorName &&
    waiting.speakerId === next.speakerId &&
    waiting.speed === next.speed
  );
}

/** A line's messages read as one sentence. */
function lineText(segments: readonly Segment[]): string {
  let text = segments[0]?.text ?? '';
  for (const segment of segments.slice(1)) {
    // Never null: a message is only merged in where the whole line fits.
    text = joinSpeech(text, segment.text) ?? text;
  }
  return text;
}

/** Index of the first part with sound; -1 when the line ends before any. */
async function firstAudible(
  parts: ReadonlyArray<Promise<Buffer | null>>
): Promise<number> {
  for (let index = 0; index < parts.length; index++) {
    const pcm = await parts[index];
    if (pcm === null) return -1;
    if (pcm.length > 0) return index;
  }
  return -1;
}

export class TtsSessionManager {
  /** Keyed by voice channel id; at most one per guild. */
  private readonly sessions = new Map<string, Session>();
  private sessionCount = 0;
  /**
   * False once a line's text failed to render, or never arrived before the
   * line ended, until a line's text renders again. While false, an announced
   * name waits for the text's first slice instead of playing at once: with
   * the engine down or stalled, the bot would otherwise read out names and
   * nothing after them.
   */
  private textHealthy = true;

  constructor(
    private readonly deps: TtsPlaybackDeps,
    private readonly now: () => number = Date.now,
    private readonly scheduler: SynthesisScheduler = new SynthesisScheduler(),
    private readonly names: NameAudioCache = new NameAudioCache()
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
    /** Characters the start message credits. */
    creditedCharacters?: Iterable<string>;
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
      for (const character of params.creditedCharacters ?? []) {
        existing.info.creditedCharacters.add(character);
      }
      return existing.info;
    }

    const session: Session = {
      key: `tts:${params.voiceChannelId}:${++this.sessionCount}`,
      info: {
        guildId: params.guildId,
        voiceChannelId: params.voiceChannelId,
        textChannelIds: new Set([params.voiceChannelId, params.textChannelId]),
        creditedCharacters: new Set(params.creditedCharacters),
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

    // Unmuted for the session; stop() mutes again, so the member list shows
    // the bot as muted whenever it cannot be heard.
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
    if (session.current) this.cancel(session.current);
    for (const item of session.queue) this.cancel(item);
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

  /**
   * Record that a character's credit is being shown in this session. True
   * the first time for each character - the caller then posts the credit -
   * and false once it has been, or when there is no session any more.
   */
  creditCharacter(voiceChannelId: string, character: string): boolean {
    const credited = this.sessions.get(voiceChannelId)?.info.creditedCharacters;
    if (!credited || credited.has(character)) return false;
    credited.add(character);
    return true;
  }

  /** Lines waiting to be spoken, not counting the one playing. */
  queueLength(voiceChannelId: string): number {
    return this.sessions.get(voiceChannelId)?.queue.length ?? 0;
  }

  /**
   * Load voice models on the engine before anyone's first line needs them.
   * Runs behind every waiting line and never delays one.
   */
  warmUp(speakerIds: Iterable<number>): void {
    const initialize = this.deps.initializeSpeaker;
    if (!initialize) return;
    for (const speakerId of new Set(speakerIds)) {
      this.scheduler
        .submit(WARM_UP_KEY, () => initialize(speakerId), { background: true })
        .promise.catch((error: unknown) => {
          logger.debug(
            `TTS voice ${speakerId} warm-up failed: ${getErrorMessage(error)}`
          );
        });
    }
  }

  /**
   * Queue a line. A speaker's line is folded into their previous one while
   * that one is still waiting and both fit in one message's length, so a
   * run of short messages is read as one sentence with one name.
   */
  enqueue(voiceChannelId: string, request: SpeechRequest): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session) return false;

    const { text, ...voice } = request;
    // Each message keeps its own posting time, so one merged into a waiting
    // line never carries that line's older messages past the age limit.
    const segment: Segment = { text, postedAt: this.now() };
    const last = session.queue.at(-1);
    if (
      last &&
      !last.render &&
      canMerge(last.voice, request) &&
      joinSpeech(lineText(last.segments), text) !== null
    ) {
      last.segments.push(segment);
      return true;
    }

    if (session.queue.length >= MAX_QUEUE_LENGTH) {
      this.dropOldestWaiting(session);
    }
    session.queue.push({ voice, segments: [segment] });

    this.pump(session).catch((error: unknown) => {
      logger.error('TTS queue stopped:', getErrorMessage(error));
    });
    return true;
  }

  /** Stop the line being spoken (or about to be); the queue carries on. */
  skip(voiceChannelId: string): boolean {
    const session = this.sessions.get(voiceChannelId);
    if (!session?.current) return false;
    this.cancel(session.current);
    this.deps.getPlayer(voiceChannelId)?.stop(true);
    return true;
  }

  private cancel(item: QueueItem): void {
    item.cancelled = true;
    for (const job of item.render?.jobs ?? []) job.cancel();
  }

  /**
   * Make room for a new line. The oldest line not yet handed to the engine
   * goes, so no rendering work is thrown away; only if every waiting line is
   * already rendering does the oldest one go.
   */
  private dropOldestWaiting(session: Session): void {
    const index = session.queue.findIndex((item) => !item.render);
    const [dropped] = session.queue.splice(index === -1 ? 0 : index, 1);
    if (dropped) this.cancel(dropped);
    logger.debug(
      `TTS queue full in ${session.info.voiceChannelId}; dropped oldest line`
    );
  }

  /**
   * Drop every message not yet handed to the engine that was posted too long
   * ago: from a merged line only its stale messages, and a line once none of
   * its messages is left. A line already rendering is never touched.
   */
  private dropStale(session: Session): void {
    const oldest = this.now() - MAX_LINE_AGE_MS;
    let dropped = 0;
    session.queue = session.queue.filter((item) => {
      if (item.render) return true;
      const fresh = item.segments.filter(
        (segment) => segment.postedAt >= oldest
      );
      dropped += item.segments.length - fresh.length;
      item.segments = fresh;
      if (fresh.length > 0) return true;
      this.cancel(item);
      return false;
    });
    if (dropped > 0) {
      logger.debug(
        `TTS dropped ${dropped} message(s) older than ${MAX_LINE_AGE_MS / 1000}s in ${session.info.voiceChannelId}`
      );
    }
  }

  /** Drop stale messages and hand the next few lines to the engine. */
  private prefetch(session: Session): void {
    this.dropStale(session);
    for (const item of session.queue.slice(0, PREFETCH_COUNT)) {
      if (!item.render) this.submit(session, item);
    }
  }

  /**
   * Hand a line to the engine. Whether its speaker's name is announced is
   * decided here, in play order, so a line dropped before this point never
   * leaves the speaker's next line without their name.
   */
  private submit(session: Session, item: QueueItem): void {
    const { voice, segments } = item;
    const text = lineText(segments);
    const postedAt = segments[0]?.postedAt ?? this.now();
    const announce =
      voice.authorName !== '' &&
      (voice.authorId !== session.lastAuthorId ||
        postedAt - session.lastSpokenAt > NAME_REANNOUNCE_MS);
    session.lastAuthorId = voice.authorId;
    session.lastSpokenAt = segments.at(-1)?.postedAt ?? postedAt;

    const render: LineRender = { parts: [], jobs: [], announced: announce };
    item.render = render;
    const { speakerId, speed } = voice;

    let nameJob: ScheduledJob<unknown> | undefined;
    if (announce) {
      const name = this.nameAudio(session, voice.authorName, speakerId, speed);
      nameJob = name.job;
      if (nameJob) render.jobs.push(nameJob);
      render.parts.push(name.audio);
    }

    // One job asks for the query and renders the first slice; the remaining
    // slices queue right behind it, ahead of the session's next line. All of
    // the line's jobs after its first are one turn with the engine.
    const textJob: ScheduledJob<Buffer> = this.scheduler.submit(
      session.key,
      async (token: JobToken) => {
        const slices = await this.deps.prepare(text, speakerId, speed);
        if (token.cancelled || item.cancelled || slices.length === 0) {
          return null;
        }
        let previous: ScheduledJob<unknown> = textJob;
        for (const slice of slices.slice(1)) {
          const job = this.scheduler.submit(session.key, slice, {
            after: previous,
          });
          render.jobs.push(job);
          render.parts.push(this.settle(job.promise, render));
          previous = job;
        }
        return slices[0]();
      },
      { after: nameJob }
    ) as ScheduledJob<Buffer>;
    render.textJob = textJob;
    render.jobs.push(textJob);
    const textPart = this.settle(textJob.promise, render, (rendered) => {
      render.textRendered = rendered;
      this.textHealthy = rendered;
    });
    render.textPart = textPart;
    render.parts.push(textPart);
  }

  /** The announced name: from the cache, or rendered (and cached) first. */
  private nameAudio(
    session: Session,
    name: string,
    speakerId: number,
    speed: number
  ): { audio: Promise<Buffer | null>; job?: ScheduledJob<unknown> } {
    const cached = this.names.get(name, speakerId, speed);
    if (cached) return { audio: Promise.resolve(cached) };

    const job = this.scheduler.submit(session.key, async () => {
      const pcm = await this.deps.renderName(name, speakerId, speed);
      this.names.set(name, speakerId, speed, pcm);
      return pcm;
    });
    // A name that cannot be rendered is left out; the line itself still plays.
    const audio = job.promise.catch((error: unknown) => {
      logger.warn(`TTS name synthesis failed: ${getErrorMessage(error)}`);
      return NO_AUDIO;
    });
    return { audio, job };
  }

  /**
   * A failed render ends the line there instead of failing the queue: what
   * rendered before it still plays, and nothing after it is rendered.
   * `onOutcome` hears whether the part rendered (true) or failed (false); a
   * part cancelled before it rendered tells it nothing.
   */
  private settle(
    promise: Promise<Buffer | null>,
    render: LineRender,
    onOutcome?: (rendered: boolean) => void
  ): Promise<Buffer | null> {
    return promise.then(
      (pcm) => {
        if (pcm !== null) onOutcome?.(true);
        return pcm;
      },
      (error: unknown) => {
        logger.warn(`TTS synthesis failed: ${getErrorMessage(error)}`);
        for (const job of render.jobs) job.cancel();
        onOutcome?.(false);
        return null;
      }
    );
  }

  /** The audio of a line from its first audible part, ending where it fails. */
  private async *lineAudio(
    session: Session,
    item: QueueItem,
    start: number
  ): AsyncGenerator<Buffer> {
    const parts = item.render?.parts ?? [];
    for (let index = start; index < parts.length; index++) {
      if (item.cancelled || session.stopped) return;
      const pcm = await parts[index];
      if (pcm === null || item.cancelled || session.stopped) return;
      if (pcm.length > 0) yield pcm;
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
        const item = session.queue.shift();
        if (!item) break;
        session.current = item;
        if (!item.render) this.submit(session, item);
        // Hand the next lines to the engine while this one renders and plays.
        this.prefetch(session);

        const render = item.render;
        let start = await firstAudible(render?.parts ?? []);
        if (start === 0 && render?.announced) {
          if (this.textHealthy) {
            // A cached name is ready at once, but announcing it while the
            // text still waits behind another server's request would leave
            // the name hanging in silence: start once the engine is on it.
            await render.textJob?.started;
          } else if ((await render.textPart) === null) {
            // The engine has been failing: a name is only announced once
            // the text is known to follow, never on its own.
            start = -1;
          }
        }
        if (session.stopped) break;
        if (item.cancelled || start < 0) continue;

        const player = this.deps.getPlayer(session.info.voiceChannelId);
        if (!player) {
          this.stop(session.info.voiceChannelId, { restoreMute: false });
          break;
        }
        try {
          await this.deps.play(player, this.lineAudio(session, item, start));
        } catch (error) {
          // One clip that cannot play must not strand the lines behind it.
          logger.warn(`TTS playback failed: ${getErrorMessage(error)}`);
        }
        if (
          render?.textRendered === undefined &&
          !item.cancelled &&
          !session.stopped
        ) {
          // The line ran out of time before its text arrived (a stalled
          // engine): treat it as a failure, not as a line that was skipped.
          this.textHealthy = false;
        }
        // Whatever of this line is still rendering is no longer needed.
        this.cancel(item);
      }
    } finally {
      session.playing = false;
      session.current = null;
    }
  }
}

/** 20 ms of 48 kHz stereo s16le: one Opus frame. */
export const FRAME_BYTES = 3840;
const BYTES_PER_MS = PLAYBACK_BYTES_PER_SECOND / 1000;
const SILENT_FRAME = Buffer.alloc(FRAME_BYTES);
/**
 * Start filling with silence when less than this much audio is left to
 * play: the player gives a resource up after five missed frames (100 ms).
 */
const LOW_WATER_MS = 60;
/**
 * The longest silence filled in for a late part before the line is given
 * up on: a stalled request must not keep the bot transmitting silence, and
 * the queue waiting, until its own timeout runs out.
 */
export const MAX_FILL_MS = 3_000;
/** How long past the audio's end a player may take to report idle. */
const PLAYBACK_GRACE_MS = 5_000;
/** Discord's default voice channel bitrate, plenty for speech. */
export const OPUS_BITRATE = 64_000;
/** libopus complexity 5 of 10: inaudible for speech, half the CPU. */
export const OPUS_COMPLEXITY = 5;
const OPUS_SET_COMPLEXITY_REQUEST = 4010;

interface OpusEncoderLike {
  setBitrate?(bitrate: number): void;
  encoder?: {
    applyEncoderCTL?(ctl: number, value: number): void;
    encoderCTL?(ctl: number, value: number): void;
  } | null;
}

/** Speech settings for the bundled Opus encoder; best effort. */
function tuneEncoder(resource: AudioResource): void {
  const encoder = (resource as { encoder?: unknown }).encoder as
    | OpusEncoderLike
    | undefined;
  if (!encoder) return;
  try {
    encoder.setBitrate?.(OPUS_BITRATE);
    const native = encoder.encoder;
    const control = native?.applyEncoderCTL ?? native?.encoderCTL;
    control?.call(native, OPUS_SET_COMPLEXITY_REQUEST, OPUS_COMPLEXITY);
  } catch (error) {
    logger.debug(`TTS encoder tuning skipped: ${getErrorMessage(error)}`);
  }
}

/** The promise's result if it settles within `ms`, otherwise null. */
function within<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise.then((value) => ({ value })), timeout]).finally(
    () => clearTimeout(timer)
  );
}

/**
 * PCM parts as 20 ms frames, as zero-copy views. Feeding the encoder frame
 * by frame keeps it a few packets ahead of the player instead of encoding a
 * whole clip in one synchronous call, which delayed the first packet and
 * stalled the event loop (and with it the recording of everyone speaking)
 * for up to 200 ms.
 *
 * When the next part is late, silence fills the gap once the audio already
 * sent has run out, so the player never gives up on a line mid-sentence.
 * After `MAX_FILL_MS` of silence in a row the line ends there instead.
 * `onProgress` hears how much audio is left to play after each frame.
 */
async function* pcmFrames(
  parts: AsyncIterable<Buffer> | Iterable<Buffer>,
  onProgress: (aheadMs: number) => void
): AsyncGenerator<Buffer> {
  let startedAt: number | null = null;
  let sentBytes = 0;
  let filledBytes = 0;
  const maxFillBytes = MAX_FILL_MS * BYTES_PER_MS;
  const aheadMs = (): number =>
    startedAt === null
      ? 0
      : sentBytes / BYTES_PER_MS - (Date.now() - startedAt);

  const iterator =
    Symbol.asyncIterator in parts
      ? parts[Symbol.asyncIterator]()
      : (parts as Iterable<Buffer>)[Symbol.iterator]();

  try {
    for (;;) {
      const next = Promise.resolve(iterator.next());
      let result: IteratorResult<Buffer>;
      if (startedAt === null) {
        result = await next;
      } else {
        for (;;) {
          const settled = await within(
            next,
            Math.max(0, aheadMs() - LOW_WATER_MS)
          );
          if (settled) {
            result = settled.value;
            break;
          }
          if (filledBytes >= maxFillBytes) {
            logger.warn(
              `TTS line cut short: its next part was over ${MAX_FILL_MS} ms late`
            );
            return;
          }
          filledBytes += FRAME_BYTES;
          sentBytes += FRAME_BYTES;
          onProgress(aheadMs());
          yield SILENT_FRAME;
        }
      }
      if (result.done) return;

      const pcm = result.value;
      if (pcm.length > 0) filledBytes = 0;
      for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
        startedAt ??= Date.now();
        const frame = pcm.subarray(offset, offset + FRAME_BYTES);
        sentBytes += frame.length;
        onProgress(aheadMs());
        yield frame;
      }
    }
  } finally {
    const closing = iterator.return?.();
    if (closing instanceof Promise) closing.catch(() => undefined);
  }
}

/**
 * Play 48 kHz stereo s16le PCM - one buffer, or a line's parts as they
 * render - and resolve when it ends, is skipped, or errors. A watchdog a
 * little past the end of the audio sent so far guards against a player that
 * never reports idle, so one stuck clip cannot stall the queue.
 */
export function playPcm(
  player: AudioPlayer,
  audio: Buffer | AsyncIterable<Buffer>
): Promise<void> {
  return new Promise((resolve) => {
    const knownMs = Buffer.isBuffer(audio) ? playbackDurationMs(audio) : 0;
    let deadline = Date.now() + knownMs + PLAYBACK_GRACE_MS;

    const frames = pcmFrames(Buffer.isBuffer(audio) ? [audio] : audio, (ms) => {
      deadline = Math.max(deadline, Date.now() + ms + PLAYBACK_GRACE_MS);
    });
    const stream = Readable.from(frames, {
      objectMode: false,
      highWaterMark: FRAME_BYTES * 4,
    });
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });
    tuneEncoder(resource);

    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      player.off(AudioPlayerStatus.Idle, finish);
      player.off('error', onError);
      stream.destroy();
      resolve();
    };
    const onError = (error: Error): void => {
      logger.debug(`TTS playback error: ${getErrorMessage(error)}`);
      finish();
    };
    const watch = (): void => {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(watch, remaining);
      } else {
        // Stop it too, so a clip that was only stuck cannot resume later over
        // the next one.
        player.stop(true);
        finish();
      }
    };
    timer = setTimeout(watch, deadline - Date.now());

    player.on(AudioPlayerStatus.Idle, finish);
    player.on('error', onError);
    try {
      player.play(resource);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Pause after an announced name before the line: the comma the name used
 * to be joined with.
 */
const NAME_PAUSE_SECONDS = 0.25;

function requireClient(): VoicevoxClient {
  const client = getVoicevoxClient();
  if (!client) throw new VoicevoxError('VOICEVOX_URL is not set');
  return client;
}

export const ttsSessions = new TtsSessionManager(
  {
    getPlayer: (voiceChannelId) => connectionManager.getPlayer(voiceChannelId),
    setSelfMute: (voiceChannelId, muted) =>
      connectionManager.setSelfMute(voiceChannelId, muted),
    prepare: async (text, speakerId, speed) => {
      const client = requireClient();
      const query = await client.audioQuery(text, speakerId);
      return sliceQuery(query).map(
        (slice) => () => client.renderQuery(slice, speakerId, speed)
      );
    },
    renderName: async (name, speakerId, speed) =>
      requireClient().synthesize(name, speakerId, speed, {
        postPhonemeLength: NAME_PAUSE_SECONDS,
      }),
    initializeSpeaker: async (speakerId) =>
      getVoicevoxClient()?.initializeSpeaker(speakerId) ?? false,
    play: playPcm,
  },
  Date.now,
  new SynthesisScheduler()
);
