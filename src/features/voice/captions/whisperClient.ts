import { env } from '../../../config/index.js';

/**
 * HTTP client for a self-hosted Whisper engine through the OpenAI-compatible
 * transcription endpoint (`POST /v1/audio/transcriptions`, multipart).
 *
 * That one shape is served by faster-whisper servers (speaches) and by
 * whisper.cpp's server started with `--inference-path
 * /v1/audio/transcriptions`, so the engine can be swapped without touching
 * the bot. Audio never leaves the private network.
 */

export interface TranscriptSegment {
  text: string;
  /** Probability the segment is not speech at all, when the engine says. */
  noSpeechProb?: number;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
}

export class WhisperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhisperError';
  }
}

export interface WhisperClientOptions {
  /** Model id, for engines that serve several (speaches); omitted if empty. */
  model?: string;
  /** ISO-639-1 language hint; skipping detection is faster and steadier. */
  language?: string;
  fetchImpl?: typeof fetch;
  /** Per-request limit; the default covers a 15 s cut on a small CPU. */
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 3_000;

interface RawSegment {
  text?: unknown;
  no_speech_prob?: unknown;
}

export class WhisperClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly options: WhisperClientOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * True when the engine answers at all. Engines differ on what `/` returns
   * (a page, a 404), so any response below 500 counts as reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  /** Transcribe one WAV file. Throws WhisperError on any failure. */
  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<Transcript> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(wav)], { type: 'audio/wav' }),
      'speech.wav'
    );
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (this.options.language) form.append('language', this.options.language);
    if (this.options.model) form.append('model', this.options.model);

    const timeout = AbortSignal.timeout(
      this.options.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/v1/audio/transcriptions`,
        {
          method: 'POST',
          body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new WhisperError(
        timeout.aborted
          ? 'Whisper did not answer in time'
          : `Whisper is unreachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      throw new WhisperError(
        `Whisper answered ${response.status} ${response.statusText}`
      );
    }

    let body: { text?: unknown; segments?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new WhisperError('Whisper returned something other than JSON');
    }
    if (typeof body.text !== 'string') {
      throw new WhisperError('Whisper returned no text');
    }

    const segments = Array.isArray(body.segments)
      ? (body.segments as RawSegment[]).map((segment) => ({
          text: typeof segment.text === 'string' ? segment.text : '',
          ...(typeof segment.no_speech_prob === 'number'
            ? { noSpeechProb: segment.no_speech_prob }
            : {}),
        }))
      : [];
    return { text: body.text, segments };
  }
}

let client: WhisperClient | null = null;
let clientKey = '';

/**
 * The engine client, or null when captions are not configured. Built on
 * first use so importing this module never reads configuration.
 */
export function getWhisperClient(): WhisperClient | null {
  const url = env.WHISPER_URL;
  if (!url) return null;
  const key = [url, env.WHISPER_MODEL, env.WHISPER_LANGUAGE].join('\n');
  if (!client || clientKey !== key) {
    client = new WhisperClient(url, {
      model: env.WHISPER_MODEL,
      language: env.WHISPER_LANGUAGE,
    });
    clientKey = key;
  }
  return client;
}
