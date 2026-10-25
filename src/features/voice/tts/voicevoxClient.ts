import { env } from '../../../config/index.js';
import { extractPcm, InvalidWavError } from './wav.js';

/**
 * HTTP client for a VOICEVOX engine (https://voicevox.hiroshiba.jp/).
 *
 * Synthesis is a two-step API: `/audio_query` turns text into an editable
 * query (accents, timing), `/synthesis` renders that query to WAV. The query
 * is where speed and the output format are set, so the engine hands back
 * 48 kHz stereo audio that Discord can play without resampling.
 *
 * Because the query lists every accent phrase, one query can also be cut at
 * its pauses and rendered piece by piece (`sliceQuery`): the first clause is
 * playing while the rest renders, and the line keeps the intonation of the
 * whole sentence, which separate requests per clause would not.
 */

export interface VoicevoxVoice {
  /** Style id, the value `/audio_query?speaker=` takes. */
  id: number;
  /** Character name, used for the credit line VOICEVOX requires. */
  character: string;
  /** Style name such as ノーマル or あまあま. */
  style: string;
}

/** One mora of an AudioQuery; lengths are seconds at speedScale 1. */
export interface AudioQueryMora {
  consonant_length?: number | null;
  vowel_length?: number;
  [field: string]: unknown;
}

export interface AccentPhrase {
  moras?: AudioQueryMora[];
  /** The pause after this phrase (punctuation), or null. */
  pause_mora?: AudioQueryMora | null;
  [field: string]: unknown;
}

/**
 * The parts of VOICEVOX's AudioQuery this client reads or sets. Everything
 * else is passed back to the engine untouched.
 */
export interface AudioQuery {
  accent_phrases?: AccentPhrase[];
  speedScale?: number;
  prePhonemeLength?: number;
  postPhonemeLength?: number;
  outputSamplingRate?: number;
  outputStereo?: boolean;
  [field: string]: unknown;
}

/** Silence around an utterance, in seconds. */
export interface UtteranceEdges {
  prePhonemeLength?: number;
  postPhonemeLength?: number;
}

interface RawSpeaker {
  name: string;
  styles?: Array<{ name: string; id: number; type?: string }>;
}

export class VoicevoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoicevoxError';
  }
}

/** ずんだもん (ノーマル): the voice most Japanese reading bots default to. */
export const DEFAULT_SPEAKER_ID = 3;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;

/**
 * Silence kept before and after an utterance. VOICEVOX pads 0.1 s on each
 * side by default; half of that still never clips a word's onset and takes
 * about 0.1 s off every gap between lines.
 */
export const EDGE_SILENCE_SECONDS = 0.05;

const SPEAKER_CACHE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;
/** Loading a voice model takes a second or more on a cold engine. */
const INITIALIZE_TIMEOUT_MS = 60_000;

/** The first slice is short so it starts playing sooner. */
const FIRST_SLICE_MIN_MORAS = 4;
/** Later slices only need to render before the one before them ends. */
const SLICE_MIN_MORAS = 8;
/** A tail shorter than this stays with the slice before it. */
const SLICE_MIN_TAIL_MORAS = 4;

type FetchLike = typeof fetch;

/**
 * Time allowed for `/synthesis`. Rendering takes longer the more audio it
 * makes - a maximum-length line takes about 15 s on a one-vCPU engine - so a
 * flat limit would drop exactly the longest lines. Never below 15 s.
 */
export function synthesisTimeoutMs(audioSeconds: number): number {
  const seconds = Number.isFinite(audioSeconds) ? Math.max(0, audioSeconds) : 0;
  return Math.max(REQUEST_TIMEOUT_MS, Math.round(5_000 + 1_500 * seconds));
}

function moraSeconds(mora: AudioQueryMora | null | undefined): number {
  if (!mora) return 0;
  const consonant =
    typeof mora.consonant_length === 'number' ? mora.consonant_length : 0;
  const vowel = typeof mora.vowel_length === 'number' ? mora.vowel_length : 0;
  return consonant + vowel;
}

function moraCount(phrase: AccentPhrase): number {
  return Array.isArray(phrase.moras) ? phrase.moras.length : 0;
}

function phrasesOf(query: AudioQuery): AccentPhrase[] {
  return Array.isArray(query.accent_phrases) ? query.accent_phrases : [];
}

/** How long a query will sound, in seconds, from its own timing data. */
export function estimateAudioSeconds(query: AudioQuery): number {
  let seconds = 0;
  for (const phrase of phrasesOf(query)) {
    for (const mora of phrase.moras ?? []) seconds += moraSeconds(mora);
    seconds += moraSeconds(phrase.pause_mora);
  }
  const speed =
    typeof query.speedScale === 'number' && query.speedScale > 0
      ? query.speedScale
      : 1;
  const edges =
    (typeof query.prePhonemeLength === 'number' ? query.prePhonemeLength : 0) +
    (typeof query.postPhonemeLength === 'number' ? query.postPhonemeLength : 0);
  return seconds / speed + edges;
}

export interface SliceOptions {
  /** Moras the first slice needs before it may end at a pause. */
  firstMinMoras?: number;
  /** Moras every later slice needs before it may end at a pause. */
  minMoras?: number;
  /** A cut is skipped when fewer moras than this would follow it. */
  minTailMoras?: number;
}

/**
 * Cut one AudioQuery into slices that can be rendered one after another and
 * played back to back. Cuts fall only after an accent phrase that ends in a
 * pause (、。), so the seams land where the voice already stops. The first
 * slice keeps the leading silence and the last the trailing silence; the
 * seams get none. A line with no pause is a single slice.
 */
export function sliceQuery(
  query: AudioQuery,
  {
    firstMinMoras = FIRST_SLICE_MIN_MORAS,
    minMoras = SLICE_MIN_MORAS,
    minTailMoras = SLICE_MIN_TAIL_MORAS,
  }: SliceOptions = {}
): AudioQuery[] {
  const phrases = phrasesOf(query);
  const total = phrases.reduce((sum, phrase) => sum + moraCount(phrase), 0);

  const groups: AccentPhrase[][] = [];
  let current: AccentPhrase[] = [];
  let currentMoras = 0;
  let consumed = 0;

  phrases.forEach((phrase, index) => {
    current.push(phrase);
    currentMoras += moraCount(phrase);
    consumed += moraCount(phrase);

    const needed = groups.length === 0 ? firstMinMoras : minMoras;
    const isLast = index === phrases.length - 1;
    if (
      !isLast &&
      phrase.pause_mora &&
      currentMoras >= needed &&
      total - consumed >= minTailMoras
    ) {
      groups.push(current);
      current = [];
      currentMoras = 0;
    }
  });
  if (current.length > 0 || groups.length === 0) groups.push(current);

  return groups.map((group, index) => ({
    ...query,
    accent_phrases: group,
    prePhonemeLength: index === 0 ? EDGE_SILENCE_SECONDS : 0,
    postPhonemeLength: index === groups.length - 1 ? EDGE_SILENCE_SECONDS : 0,
  }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VoicevoxClient {
  private voices: VoicevoxVoice[] | null = null;
  private voicesFetchedAt = 0;
  private voicesRefresh: Promise<VoicevoxVoice[]> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** True when the engine answers at all; used before starting a session. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.request(
        '/version',
        { method: 'GET' },
        HEALTH_TIMEOUT_MS,
        (response) => response.arrayBuffer()
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Every talk style the engine offers. The list is cached for ten minutes;
   * after that the cached list is still returned at once while a single
   * refresh runs in the background, so autocomplete never waits on the
   * engine once it has answered. Only a call with nothing cached waits.
   */
  async listVoices(): Promise<VoicevoxVoice[]> {
    if (this.voices) {
      if (this.now() - this.voicesFetchedAt >= SPEAKER_CACHE_MS) {
        void this.refreshVoices().catch(() => undefined);
      }
      return this.voices;
    }
    return this.refreshVoices();
  }

  /** The cached voice list, however old, or null before the first fetch. */
  peekVoices(): VoicevoxVoice[] | null {
    return this.voices;
  }

  async findVoice(id: number): Promise<VoicevoxVoice | undefined> {
    const voices = await this.listVoices();
    return voices.find((voice) => voice.id === id);
  }

  /** One request however many callers ask at once; failures are not cached. */
  private refreshVoices(): Promise<VoicevoxVoice[]> {
    this.voicesRefresh ??= this.fetchVoices().finally(() => {
      this.voicesRefresh = null;
    });
    return this.voicesRefresh;
  }

  private async fetchVoices(): Promise<VoicevoxVoice[]> {
    const speakers = await this.request(
      '/speakers',
      { method: 'GET' },
      REQUEST_TIMEOUT_MS,
      async (response) => (await response.json()) as unknown
    );
    if (!Array.isArray(speakers)) {
      throw new VoicevoxError('VOICEVOX /speakers returned no list');
    }

    // Singing styles exist on newer engines and cannot read text.
    this.voices = (speakers as RawSpeaker[]).flatMap((speaker) =>
      (speaker.styles ?? [])
        .filter((style) => style.type === undefined || style.type === 'talk')
        .map((style) => ({
          id: style.id,
          character: speaker.name,
          style: style.name,
        }))
    );
    this.voicesFetchedAt = this.now();
    return this.voices;
  }

  /**
   * Load a voice model ahead of its first line (`skip_reinit`, so a model
   * that is already loaded costs nothing). Never throws: this is only ever a
   * head start, and the first line loads the model anyway.
   */
  async initializeSpeaker(speakerId: number): Promise<boolean> {
    try {
      await this.request(
        `/initialize_speaker?speaker=${speakerId}&skip_reinit=true`,
        { method: 'POST' },
        INITIALIZE_TIMEOUT_MS,
        (response) => response.arrayBuffer()
      );
      return true;
    } catch {
      return false;
    }
  }

  /** How the engine would say a text: accents, timing and pauses. */
  async audioQuery(text: string, speakerId: number): Promise<AudioQuery> {
    const query = await this.request(
      `/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' },
      REQUEST_TIMEOUT_MS,
      async (response) => (await response.json()) as unknown
    );
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new VoicevoxError('VOICEVOX /audio_query returned no query');
    }
    return query as AudioQuery;
  }

  /**
   * Render a query, or a slice of one, to 48 kHz stereo 16-bit PCM. The
   * silence before and after is whatever the query says.
   */
  async renderQuery(
    query: AudioQuery,
    speakerId: number,
    speed: number
  ): Promise<Buffer> {
    const body: AudioQuery = {
      ...query,
      speedScale: clampSpeed(speed),
      outputSamplingRate: 48_000,
      outputStereo: true,
    };

    const wav = await this.request(
      `/synthesis?speaker=${speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      synthesisTimeoutMs(estimateAudioSeconds(body)),
      async (response) => Buffer.from(await response.arrayBuffer())
    );

    let audio;
    try {
      audio = extractPcm(wav);
    } catch (error) {
      if (error instanceof InvalidWavError) {
        throw new VoicevoxError(error.message);
      }
      throw error;
    }

    if (
      audio.sampleRate !== 48_000 ||
      audio.channels !== 2 ||
      audio.bitsPerSample !== 16
    ) {
      throw new VoicevoxError(
        `Unexpected audio format ${audio.sampleRate}Hz/${audio.channels}ch/${audio.bitsPerSample}bit`
      );
    }
    return audio.pcm;
  }

  /**
   * Render text as one utterance, with `EDGE_SILENCE_SECONDS` of silence on
   * each side unless told otherwise.
   */
  async synthesize(
    text: string,
    speakerId: number,
    speed: number,
    edges: UtteranceEdges = {}
  ): Promise<Buffer> {
    const query = await this.audioQuery(text, speakerId);
    query.prePhonemeLength = edges.prePhonemeLength ?? EDGE_SILENCE_SECONDS;
    query.postPhonemeLength = edges.postPhonemeLength ?? EDGE_SILENCE_SECONDS;
    return this.renderQuery(query, speakerId, speed);
  }

  /**
   * One request with its own deadline, which also covers reading the body.
   * Every failure - network, status, body, timeout - is a VoicevoxError.
   */
  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const endpoint = path.split('?')[0];
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
        });
      } catch (error) {
        throw new VoicevoxError(`VOICEVOX request failed: ${describe(error)}`);
      }
      if (!response.ok) {
        throw new VoicevoxError(
          `VOICEVOX ${endpoint} returned ${response.status}`
        );
      }
      try {
        return await read(response);
      } catch (error) {
        throw new VoicevoxError(
          `VOICEVOX ${endpoint} sent an unreadable answer: ${describe(error)}`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** "ずんだもん（ノーマル）" - how a voice is shown to people. */
export function voiceLabel(voice: VoicevoxVoice): string {
  return `${voice.character}（${voice.style}）`;
}

let client: VoicevoxClient | null = null;
let clientUrl: string | null = null;

/**
 * The engine client, or null when text-to-speech is not configured.
 * Built on first use so importing this module never reads configuration.
 */
export function getVoicevoxClient(): VoicevoxClient | null {
  const url = env.VOICEVOX_URL;
  if (!url) return null;
  if (!client || clientUrl !== url) {
    client = new VoicevoxClient(url);
    clientUrl = url;
  }
  return client;
}
