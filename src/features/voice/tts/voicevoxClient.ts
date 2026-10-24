import { env } from '../../../config/index.js';
import { extractPcm, InvalidWavError } from './wav.js';

/**
 * HTTP client for a VOICEVOX engine (https://voicevox.hiroshiba.jp/).
 *
 * Synthesis is a two-step API: `/audio_query` turns text into an editable
 * query (accents, timing), `/synthesis` renders that query to WAV. The query
 * is where speed and the output format are set, so the engine hands back
 * 48 kHz stereo audio that Discord can play without resampling.
 */

export interface VoicevoxVoice {
  /** Style id, the value `/audio_query?speaker=` takes. */
  id: number;
  /** Character name, used for the credit line VOICEVOX requires. */
  character: string;
  /** Style name such as ノーマル or あまあま. */
  style: string;
}

interface RawSpeaker {
  name: string;
  styles: Array<{ name: string; id: number; type?: string }>;
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

const SPEAKER_CACHE_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;

type FetchLike = typeof fetch;

export class VoicevoxClient {
  private voices: VoicevoxVoice[] | null = null;
  private voicesFetchedAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now
  ) {}

  /** True when the engine answers at all; used before starting a session. */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/version`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Every talk style the engine offers, cached for ten minutes. */
  async listVoices(): Promise<VoicevoxVoice[]> {
    if (this.voices && this.now() - this.voicesFetchedAt < SPEAKER_CACHE_MS) {
      return this.voices;
    }

    const response = await this.request('/speakers', { method: 'GET' });
    const speakers = (await response.json()) as RawSpeaker[];

    // Singing styles exist on newer engines and cannot read text.
    this.voices = speakers.flatMap((speaker) =>
      speaker.styles
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

  async findVoice(id: number): Promise<VoicevoxVoice | undefined> {
    const voices = await this.listVoices();
    return voices.find((voice) => voice.id === id);
  }

  /**
   * Render text to 48 kHz stereo 16-bit PCM.
   */
  async synthesize(
    text: string,
    speakerId: number,
    speed: number
  ): Promise<Buffer> {
    const queryResponse = await this.request(
      `/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' }
    );
    const query = (await queryResponse.json()) as Record<string, unknown>;

    query.speedScale = clampSpeed(speed);
    query.outputSamplingRate = 48_000;
    query.outputStereo = true;

    const wavResponse = await this.request(`/synthesis?speaker=${speakerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    });
    const wav = Buffer.from(await wavResponse.arrayBuffer());

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

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new VoicevoxError(
        `VOICEVOX request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      throw new VoicevoxError(
        `VOICEVOX ${path.split('?')[0]} returned ${response.status}`
      );
    }
    return response;
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
