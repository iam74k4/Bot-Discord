import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ VOICEVOX_URL: '' }));

vi.mock('../../../config/index.js', () => ({
  env: {
    get VOICEVOX_URL() {
      return config.VOICEVOX_URL;
    },
  },
}));

const {
  clampSpeed,
  DEFAULT_SPEAKER_ID,
  getVoicevoxClient,
  MAX_SPEED,
  MIN_SPEED,
  VoicevoxClient,
  VoicevoxError,
  voiceLabel,
} = await import('../tts/voicevoxClient.js');

const BASE = 'http://voicevox.test:50021';

/** A WAV file as VOICEVOX returns it, with a chosen format. */
function wav(
  pcm: Buffer,
  { sampleRate = 48_000, channels = 2, bitsPerSample = 16 } = {}
): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const binary = (body: Buffer, status = 200) =>
  new Response(new Uint8Array(body), { status });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** fetch stand-in that routes by path and records every call. */
function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route(url, init ?? {});
  });
}

function callsOf(fetchMock: ReturnType<typeof fakeFetch>) {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    init: init ?? {},
  }));
}

const SPEAKERS = [
  {
    name: 'ずんだもん',
    styles: [
      { name: 'ノーマル', id: 3, type: 'talk' },
      { name: 'あまあま', id: 1 },
      { name: 'ハミング', id: 3001, type: 'frame_decode' },
      { name: 'ソング', id: 3002, type: 'singing_teacher' },
    ],
  },
  {
    name: '四国めたん',
    styles: [
      { name: 'ノーマル', id: 2, type: 'talk' },
      { name: '歌', id: 6000, type: 'sing' },
    ],
  },
];

describe('VoicevoxClient', () => {
  describe('synthesize', () => {
    const PCM = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const QUERY = {
      accent_phrases: [{ moras: [] }],
      speedScale: 1,
      outputSamplingRate: 24_000,
      outputStereo: false,
    };

    it('sends audio_query then synthesis and returns the bare PCM', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json(QUERY),
        '/synthesis': () => binary(wav(PCM)),
      });
      const client = new VoicevoxClient(BASE, fetchMock);

      const pcm = await client.synthesize('こんにちは & ?', 8, 1.25);

      expect(pcm).toEqual(PCM);
      const [query, synthesis] = callsOf(fetchMock);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      expect(query.url).toBe(
        `${BASE}/audio_query?text=${encodeURIComponent('こんにちは & ?')}&speaker=8`
      );
      expect(query.init.method).toBe('POST');
      expect(query.init.signal).toBeInstanceOf(AbortSignal);

      expect(synthesis.url).toBe(`${BASE}/synthesis?speaker=8`);
      expect(synthesis.init.method).toBe('POST');
      expect(synthesis.init.headers).toEqual({
        'Content-Type': 'application/json',
      });
      expect(synthesis.init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(synthesis.init.body))).toEqual({
        accent_phrases: [{ moras: [] }],
        speedScale: 1.25,
        outputSamplingRate: 48_000,
        outputStereo: true,
      });
    });

    it.each([
      [0.1, MIN_SPEED],
      [5, MAX_SPEED],
      [Number.NaN, 1],
    ])('clamps speed %s to %s in the query', async (speed, expected) => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json({}),
        '/synthesis': () => binary(wav(PCM)),
      });
      await new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, speed);

      const body = JSON.parse(String(callsOf(fetchMock)[1].init.body));
      expect(body.speedScale).toBe(expected);
    });

    it.each([
      [{ sampleRate: 24_000 }, '24000Hz/2ch/16bit'],
      [{ channels: 1 }, '48000Hz/1ch/16bit'],
      [{ bitsPerSample: 8 }, '48000Hz/2ch/8bit'],
    ])('rejects audio in format %j', async (format, described) => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json({}),
        '/synthesis': () => binary(wav(PCM, format)),
      });
      const promise = new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1);

      await expect(promise).rejects.toBeInstanceOf(VoicevoxError);
      await expect(promise).rejects.toThrow(
        `Unexpected audio format ${described}`
      );
    });

    it('turns an unreadable WAV into a VoicevoxError', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json({}),
        '/synthesis': () => binary(Buffer.from('not a wav file')),
      });
      const promise = new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1);

      await expect(promise).rejects.toBeInstanceOf(VoicevoxError);
      await expect(promise).rejects.toThrow(
        'Invalid WAV data: missing RIFF/WAVE header'
      );
    });

    it('fails with VoicevoxError on a non-2xx audio_query and never synthesizes', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json({ detail: 'bad speaker' }, 422),
        '/synthesis': () => binary(wav(PCM)),
      });
      const promise = new VoicevoxClient(BASE, fetchMock).synthesize(
        'a',
        999,
        1
      );

      await expect(promise).rejects.toBeInstanceOf(VoicevoxError);
      await expect(promise).rejects.toThrow(
        'VOICEVOX /audio_query returned 422'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails with VoicevoxError on a non-2xx synthesis', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json({}),
        '/synthesis': () => binary(Buffer.alloc(0), 500),
      });
      await expect(
        new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1)
      ).rejects.toThrow('VOICEVOX /synthesis returned 500');
    });

    it('wraps network failures in VoicevoxError', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      });
      const promise = new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1);

      await expect(promise).rejects.toBeInstanceOf(VoicevoxError);
      await expect(promise).rejects.toThrow(
        'VOICEVOX request failed: connect ECONNREFUSED'
      );
    });

    it('describes a non-Error rejection too', async () => {
      const fetchMock = vi.fn(() => Promise.reject('socket hang up'));
      await expect(
        new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1)
      ).rejects.toThrow('VOICEVOX request failed: socket hang up');
    });
  });

  describe('listVoices', () => {
    let now: number;
    const clock = () => now;

    beforeEach(() => {
      now = 1_000_000;
    });

    it('requests /speakers and keeps only talk styles', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const voices = await new VoicevoxClient(
        BASE,
        fetchMock,
        clock
      ).listVoices();

      expect(callsOf(fetchMock)[0].url).toBe(`${BASE}/speakers`);
      expect(callsOf(fetchMock)[0].init.method).toBe('GET');
      expect(voices).toEqual([
        { id: 3, character: 'ずんだもん', style: 'ノーマル' },
        { id: 1, character: 'ずんだもん', style: 'あまあま' },
        { id: 2, character: '四国めたん', style: 'ノーマル' },
      ]);
    });

    it('caches the list for ten minutes and refetches afterwards', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      const first = await client.listVoices();
      now += 10 * 60 * 1000 - 1;
      expect(await client.listVoices()).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 1;
      const refreshed = await client.listVoices();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(refreshed).toEqual(first);
      expect(refreshed).not.toBe(first);

      // The new fetch restarts the window.
      now += 60 * 1000;
      await client.listVoices();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed fetch', async () => {
      let healthy = false;
      const fetchMock = fakeFetch({
        '/speakers': () => (healthy ? json(SPEAKERS) : json({}, 503)),
      });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      await expect(client.listVoices()).rejects.toThrow(
        'VOICEVOX /speakers returned 503'
      );
      healthy = true;
      await expect(client.listVoices()).resolves.toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('finds a voice by style id', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      await expect(client.findVoice(2)).resolves.toEqual({
        id: 2,
        character: '四国めたん',
        style: 'ノーマル',
      });
      await expect(client.findVoice(3001)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('isAvailable', () => {
    it('is true when /version answers 2xx', async () => {
      const fetchMock = fakeFetch({ '/version': () => json('0.14.0') });
      await expect(
        new VoicevoxClient(BASE, fetchMock).isAvailable()
      ).resolves.toBe(true);
      expect(callsOf(fetchMock)[0].url).toBe(`${BASE}/version`);
      expect(callsOf(fetchMock)[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it('is false on a non-2xx answer', async () => {
      const fetchMock = fakeFetch({ '/version': () => json({}, 503) });
      await expect(
        new VoicevoxClient(BASE, fetchMock).isAvailable()
      ).resolves.toBe(false);
    });

    it('is false on a network error instead of throwing', async () => {
      const fetchMock = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      await expect(
        new VoicevoxClient(BASE, fetchMock).isAvailable()
      ).resolves.toBe(false);
    });
  });
});

describe('VoicevoxError', () => {
  it('is a named Error', () => {
    const error = new VoicevoxError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VoicevoxError');
    expect(error.message).toBe('boom');
  });
});

describe('clampSpeed', () => {
  it.each([
    [1, 1],
    [1.37, 1.37],
    [MIN_SPEED, MIN_SPEED],
    [MAX_SPEED, MAX_SPEED],
    [0, MIN_SPEED],
    [-3, MIN_SPEED],
    [2.5, MAX_SPEED],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 1],
  ])('%s -> %s', (input, expected) => {
    expect(clampSpeed(input)).toBe(expected);
  });

  it('uses the documented bounds', () => {
    expect(MIN_SPEED).toBe(0.5);
    expect(MAX_SPEED).toBe(2);
    expect(DEFAULT_SPEAKER_ID).toBe(3);
  });
});

describe('voiceLabel', () => {
  it('formats character and style with full-width parentheses', () => {
    expect(
      voiceLabel({ id: 3, character: 'ずんだもん', style: 'ノーマル' })
    ).toBe('ずんだもん（ノーマル）');
  });
});

describe('getVoicevoxClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    config.VOICEVOX_URL = '';
  });

  it('returns null when VOICEVOX_URL is empty', () => {
    config.VOICEVOX_URL = '';
    expect(getVoicevoxClient()).toBeNull();
  });

  it('builds one client per URL and talks to that URL', async () => {
    const fetchMock = fakeFetch({ '/version': () => json('0.14.0') });
    vi.stubGlobal('fetch', fetchMock);

    config.VOICEVOX_URL = 'http://engine-a:50021';
    const a = getVoicevoxClient();
    expect(a).toBeInstanceOf(VoicevoxClient);
    expect(getVoicevoxClient()).toBe(a);

    await a!.isAvailable();
    expect(callsOf(fetchMock)[0].url).toBe('http://engine-a:50021/version');

    config.VOICEVOX_URL = 'http://engine-b:50021';
    const b = getVoicevoxClient();
    expect(b).not.toBe(a);
    await b!.isAvailable();
    expect(callsOf(fetchMock)[1].url).toBe('http://engine-b:50021/version');

    config.VOICEVOX_URL = '';
    expect(getVoicevoxClient()).toBeNull();
  });
});
