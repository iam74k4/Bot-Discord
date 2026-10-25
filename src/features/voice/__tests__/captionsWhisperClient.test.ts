import { describe, expect, it, vi } from 'vitest';
import { WhisperClient, WhisperError } from '../captions/whisperClient.js';

const WAV = Buffer.from('RIFF....WAVEfmt ');

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('WhisperClient.transcribe', () => {
  it('posts the WAV to the OpenAI-compatible endpoint with the hints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ text: 'こんにちは', segments: [] }));
    const client = new WhisperClient('http://whisper:8000', {
      language: 'ja',
      model: 'Systran/faster-whisper-small',
      fetchImpl,
    });

    await client.transcribe(WAV);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://whisper:8000/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('speech.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(WAV)).toBe(true);
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('language')).toBe('ja');
    expect(form.get('model')).toBe('Systran/faster-whisper-small');
  });

  it('leaves out hints that are not configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ text: '' }));

    await new WhisperClient('http://whisper:8000', { fetchImpl }).transcribe(
      WAV
    );

    const form = (fetchImpl.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.has('language')).toBe(false);
    expect(form.has('model')).toBe(false);
  });

  it('returns the text and the per-segment no-speech probability', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        text: ' こんにちは。',
        segments: [
          { text: ' こんにちは。', no_speech_prob: 0.02 },
          { text: 'x' },
          { no_speech_prob: 'not a number' },
        ],
      })
    );

    await expect(
      new WhisperClient('http://w', { fetchImpl }).transcribe(WAV)
    ).resolves.toEqual({
      text: ' こんにちは。',
      segments: [
        { text: ' こんにちは。', noSpeechProb: 0.02 },
        { text: 'x' },
        { text: '' },
      ],
    });
  });

  it.each([
    [
      'an error status',
      () =>
        new Response('boom', {
          status: 503,
          statusText: 'Service Unavailable',
        }),
      'Whisper answered 503 Service Unavailable',
    ],
    [
      'a body that is not JSON',
      () => new Response('<html>', { status: 200 }),
      'Whisper returned something other than JSON',
    ],
    [
      'JSON without text',
      () => jsonResponse({ segments: [] }),
      'Whisper returned no text',
    ],
  ])('throws a WhisperError on %s', async (_label, respond, message) => {
    const fetchImpl = vi.fn().mockResolvedValue(respond());

    const transcribing = new WhisperClient('http://w', {
      fetchImpl,
    }).transcribe(WAV);

    await expect(transcribing).rejects.toBeInstanceOf(WhisperError);
    await expect(transcribing).rejects.toThrow(message);
  });

  it('reports an unreachable engine as a WhisperError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      new WhisperClient('http://w', { fetchImpl }).transcribe(WAV)
    ).rejects.toThrow('Whisper is unreachable: ECONNREFUSED');
  });

  it('passes the caller abort through untouched', async () => {
    const controller = new AbortController();
    const abort = new DOMException('stopped', 'AbortError');
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        controller.abort(abort);
        expect(init?.signal?.aborted).toBe(true);
        throw abort;
      }
    );

    await expect(
      new WhisperClient('http://w', { fetchImpl }).transcribe(
        WAV,
        controller.signal
      )
    ).rejects.toBe(abort);
  });

  it('names a timeout as one', async () => {
    // AbortSignal.timeout runs on Node's own timers, which fake timers do not
    // reach, so use a real but tiny limit.
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );

    await expect(
      new WhisperClient('http://w', { fetchImpl, timeoutMs: 10 }).transcribe(
        WAV
      )
    ).rejects.toThrow('Whisper did not answer in time');
  });
});

describe('WhisperClient.isAvailable', () => {
  it.each([
    [200, true],
    [404, true],
    [500, false],
  ])('treats a %i from / as reachable: %s', async (status, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status }));

    await expect(
      new WhisperClient('http://w', { fetchImpl }).isAvailable()
    ).resolves.toBe(expected);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://w/');
  });

  it('is false when the engine cannot be reached', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(
      new WhisperClient('http://w', { fetchImpl }).isAvailable()
    ).resolves.toBe(false);
  });
});
