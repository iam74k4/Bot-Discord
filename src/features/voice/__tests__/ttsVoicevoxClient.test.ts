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
  EDGE_SILENCE_SECONDS,
  estimateAudioSeconds,
  getVoicevoxClient,
  MAX_SPEED,
  MIN_SPEED,
  sliceQuery,
  synthesisTimeoutMs,
  VoicevoxClient,
  VoicevoxError,
  voiceLabel,
} = await import('../tts/voicevoxClient.js');
type AudioQuery = import('../tts/voicevoxClient.js').AudioQuery;

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

/** A route that never answers, and fails the way fetch does once aborted. */
const hanging: Route = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

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
      // Half of VOICEVOX's default 0.1 s of silence on each side.
      expect(JSON.parse(String(synthesis.init.body))).toEqual({
        accent_phrases: [{ moras: [] }],
        speedScale: 1.25,
        outputSamplingRate: 48_000,
        outputStereo: true,
        prePhonemeLength: 0.05,
        postPhonemeLength: 0.05,
      });
    });

    it('takes custom silence around the utterance', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => json(QUERY),
        '/synthesis': () => binary(wav(PCM)),
      });

      await new VoicevoxClient(BASE, fetchMock).synthesize('たろう', 3, 1, {
        postPhonemeLength: 0.25,
      });

      const body = JSON.parse(String(callsOf(fetchMock)[1].init.body));
      expect(body.prePhonemeLength).toBe(EDGE_SILENCE_SECONDS);
      expect(body.postPhonemeLength).toBe(0.25);
    });

    it('turns an unreadable audio_query answer into a VoicevoxError', async () => {
      const fetchMock = fakeFetch({
        '/audio_query': () => new Response('not json', { status: 200 }),
        '/synthesis': () => binary(wav(PCM)),
      });
      const promise = new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1);

      await expect(promise).rejects.toBeInstanceOf(VoicevoxError);
      await expect(promise).rejects.toThrow(
        'VOICEVOX /audio_query sent an unreadable answer'
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an array', []],
      ['null', null],
    ])('rejects %s as an audio_query answer', async (_label, body) => {
      const fetchMock = fakeFetch({ '/audio_query': () => json(body) });
      await expect(
        new VoicevoxClient(BASE, fetchMock).synthesize('a', 3, 1)
      ).rejects.toThrow('VOICEVOX /audio_query returned no query');
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

    it('caches the list for ten minutes', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      const first = await client.listVoices();
      now += 10 * 60 * 1000 - 1;
      expect(await client.listVoices()).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('answers from an expired list at once and refreshes it once in the background', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const fetchMock = fakeFetch({
        '/speakers': async () => {
          if (fetchMock.mock.calls.length > 1) await gate;
          return json(SPEAKERS);
        },
      });
      const client = new VoicevoxClient(BASE, fetchMock, clock);
      const first = await client.listVoices();

      now += 10 * 60 * 1000;
      // Stale but immediate, however many callers ask while it refreshes.
      expect(await client.listVoices()).toBe(first);
      expect(await client.listVoices()).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      release();
      await vi.waitFor(() => expect(client.peekVoices()).not.toBe(first));
      expect(client.peekVoices()).toEqual(first);

      // The refresh restarts the ten minutes.
      now += 60 * 1000;
      await client.listVoices();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the expired list when the background refresh fails, and retries next time', async () => {
      let healthy = true;
      const fetchMock = fakeFetch({
        '/speakers': () => (healthy ? json(SPEAKERS) : json({}, 503)),
      });
      const client = new VoicevoxClient(BASE, fetchMock, clock);
      const first = await client.listVoices();

      healthy = false;
      now += 10 * 60 * 1000;
      expect(await client.listVoices()).toBe(first);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await Promise.resolve();
      expect(client.peekVoices()).toBe(first);

      healthy = true;
      await client.listVoices();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    });

    it('makes one request for callers that arrive while the first fetch runs', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => client.listVoices())
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (const voices of results) expect(voices).toBe(results[0]);
    });

    it('peeks at nothing before the first fetch, then at the cached list', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json(SPEAKERS) });
      const client = new VoicevoxClient(BASE, fetchMock, clock);

      expect(client.peekVoices()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();

      const voices = await client.listVoices();
      now += 60 * 60 * 1000;
      expect(client.peekVoices()).toBe(voices);
      // Peeking never asks the engine, however old the list is.
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      expect(client.peekVoices()).toBeNull();
      healthy = true;
      await expect(client.listVoices()).resolves.toHaveLength(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects an answer that is not a list of speakers', async () => {
      const fetchMock = fakeFetch({ '/speakers': () => json({}) });
      await expect(
        new VoicevoxClient(BASE, fetchMock, clock).listVoices()
      ).rejects.toThrow('VOICEVOX /speakers returned no list');
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

  describe('renderQuery', () => {
    const PCM = Buffer.from([5, 0, 6, 0, 7, 0, 8, 0]);

    it('renders the query as given, with speed and output format set', async () => {
      const fetchMock = fakeFetch({ '/synthesis': () => binary(wav(PCM)) });
      const slice: AudioQuery = {
        accent_phrases: [{ moras: [{ vowel_length: 0.1 }] }],
        prePhonemeLength: 0,
        postPhonemeLength: 0.05,
        intonationScale: 1.2,
      };

      const pcm = await new VoicevoxClient(BASE, fetchMock).renderQuery(
        slice,
        2,
        3
      );

      expect(pcm).toEqual(PCM);
      expect(callsOf(fetchMock)[0].url).toBe(`${BASE}/synthesis?speaker=2`);
      expect(JSON.parse(String(callsOf(fetchMock)[0].init.body))).toEqual({
        ...slice,
        speedScale: MAX_SPEED,
        outputSamplingRate: 48_000,
        outputStereo: true,
      });
      // The caller's query is left alone.
      expect(slice.speedScale).toBeUndefined();
    });
  });

  describe('timeouts', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A query whose moras add up to `seconds` of speech. */
    function queryOf(seconds: number): AudioQuery {
      const moras = Array.from({ length: 100 }, () => ({
        consonant_length: null,
        vowel_length: seconds / 100,
      }));
      return {
        accent_phrases: [{ moras, pause_mora: null }],
        prePhonemeLength: 0.05,
        postPhonemeLength: 0.05,
      };
    }

    async function outcome(promise: Promise<unknown>) {
      let settled: unknown = 'pending';
      promise.then(
        () => (settled = 'resolved'),
        (error: unknown) => (settled = error)
      );
      await Promise.resolve();
      return () => settled;
    }

    it('gives a long line time scaled to its length instead of 15 s', async () => {
      const fetchMock = fakeFetch({ '/synthesis': hanging });
      const client = new VoicevoxClient(BASE, fetchMock);
      // 18 s of speech plus 0.1 s of edges: 5 s + 1.5 × 18.1 s.
      const limit = 32_150;

      const state = await outcome(client.renderQuery(queryOf(18), 3, 1));

      await vi.advanceTimersByTimeAsync(15_000);
      expect(state()).toBe('pending');
      await vi.advanceTimersByTimeAsync(limit - 15_000 - 1);
      expect(state()).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      expect(state()).toBeInstanceOf(VoicevoxError);
      expect((state() as Error).message).toBe(
        `VOICEVOX request failed: timed out after ${limit} ms`
      );
    });

    it('scales by speed: the same line at double speed gets less time', () => {
      const atSpeed = (speed: number) =>
        synthesisTimeoutMs(
          estimateAudioSeconds({ ...queryOf(18), speedScale: speed })
        );
      expect(atSpeed(2)).toBeLessThan(atSpeed(1));
      expect(atSpeed(2)).toBe(Math.round(5_000 + 1_500 * 9.1));
    });

    it('still gives a short line 15 s', async () => {
      const fetchMock = fakeFetch({ '/synthesis': hanging });
      const state = await outcome(
        new VoicevoxClient(BASE, fetchMock).renderQuery(queryOf(1), 3, 1)
      );

      await vi.advanceTimersByTimeAsync(14_999);
      expect(state()).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect((state() as Error).message).toBe(
        'VOICEVOX request failed: timed out after 15000 ms'
      );
    });

    it('keeps 15 s for audio_query, however long the text', async () => {
      const fetchMock = fakeFetch({ '/audio_query': hanging });
      const state = await outcome(
        new VoicevoxClient(BASE, fetchMock).audioQuery('あ'.repeat(100), 3)
      );

      await vi.advanceTimersByTimeAsync(14_999);
      expect(state()).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(state()).toBeInstanceOf(VoicevoxError);
    });

    it('leaves no timer behind once a request has answered', async () => {
      const fetchMock = fakeFetch({ '/version': () => json('0.14.0') });
      await new VoicevoxClient(BASE, fetchMock).isAvailable();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('initializeSpeaker', () => {
    it('asks the engine to load the voice, skipping a model already loaded', async () => {
      const fetchMock = fakeFetch({
        '/initialize_speaker': () => new Response(null, { status: 204 }),
      });

      await expect(
        new VoicevoxClient(BASE, fetchMock).initializeSpeaker(14)
      ).resolves.toBe(true);

      const [call] = callsOf(fetchMock);
      expect(call.url).toBe(
        `${BASE}/initialize_speaker?speaker=14&skip_reinit=true`
      );
      expect(call.init.method).toBe('POST');
    });

    it.each<[string, Route]>([
      ['an error status', () => json({}, 422)],
      [
        'a network failure',
        () => {
          throw new Error('ECONNREFUSED');
        },
      ],
    ])('reports false on %s instead of throwing', async (_label, route) => {
      const fetchMock = fakeFetch({ '/initialize_speaker': route });
      await expect(
        new VoicevoxClient(BASE, fetchMock).initializeSpeaker(14)
      ).resolves.toBe(false);
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

describe('sliceQuery', () => {
  /** An accent phrase of `count` moras, ending in a pause when asked. */
  function phrase(name: string, count: number, pause = false) {
    return {
      name,
      moras: Array.from({ length: count }, () => ({ vowel_length: 0.1 })),
      pause_mora: pause ? { vowel_length: 0.3 } : null,
    };
  }

  const names = (slices: AudioQuery[]) =>
    slices.map((slice) =>
      (slice.accent_phrases ?? []).map((p) => p.name as string)
    );

  const base = {
    speedScale: 1,
    pitchScale: 0,
    prePhonemeLength: 0.1,
    postPhonemeLength: 0.1,
    kana: 'whatever',
  };

  it('keeps a line without pauses whole, with both edges', () => {
    const query = { ...base, accent_phrases: [phrase('a', 3), phrase('b', 9)] };

    const slices = sliceQuery(query);

    expect(names(slices)).toEqual([['a', 'b']]);
    expect(slices[0]).toMatchObject({
      pitchScale: 0,
      kana: 'whatever',
      prePhonemeLength: EDGE_SILENCE_SECONDS,
      postPhonemeLength: EDGE_SILENCE_SECONDS,
    });
  });

  it('cuts after pauses once a slice is long enough, first one shortest', () => {
    const query = {
      ...base,
      accent_phrases: [
        phrase('name', 4, true), // 4 moras: enough for the first slice
        phrase('b', 3, true), // 3 moras: too short for a later slice
        phrase('c', 5, true), // 8 with b: cut here
        phrase('d', 6),
      ],
    };

    expect(names(sliceQuery(query))).toEqual([['name'], ['b', 'c'], ['d']]);
  });

  it('gives the seams no silence and keeps the edges at each end', () => {
    const query = {
      ...base,
      accent_phrases: [
        phrase('a', 4, true),
        phrase('b', 8, true),
        phrase('c', 6),
      ],
    };

    const slices = sliceQuery(query);

    expect(
      slices.map((s) => [s.prePhonemeLength, s.postPhonemeLength])
    ).toEqual([
      [EDGE_SILENCE_SECONDS, 0],
      [0, 0],
      [0, EDGE_SILENCE_SECONDS],
    ]);
    // The original query is not modified.
    expect(query.prePhonemeLength).toBe(0.1);
    expect(query.accent_phrases).toHaveLength(3);
  });

  it('never cuts before the last phrase or leaves a tail of a few moras', () => {
    const query = {
      ...base,
      accent_phrases: [phrase('a', 6, true), phrase('b', 3, true)],
    };

    expect(names(sliceQuery(query))).toEqual([['a', 'b']]);
  });

  it('does not cut a first slice shorter than the minimum', () => {
    const query = {
      ...base,
      accent_phrases: [phrase('a', 3, true), phrase('b', 9)],
    };

    expect(names(sliceQuery(query))).toEqual([['a', 'b']]);
    expect(names(sliceQuery(query, { firstMinMoras: 3 }))).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('turns a query without phrases into one empty slice', () => {
    expect(sliceQuery({})).toEqual([
      {
        accent_phrases: [],
        prePhonemeLength: EDGE_SILENCE_SECONDS,
        postPhonemeLength: EDGE_SILENCE_SECONDS,
      },
    ]);
  });
});

describe('estimateAudioSeconds', () => {
  it('adds up moras, pauses and edges, divided by speed', () => {
    const query: AudioQuery = {
      accent_phrases: [
        {
          moras: [
            { consonant_length: 0.05, vowel_length: 0.1 },
            { consonant_length: null, vowel_length: 0.2 },
          ],
          pause_mora: { vowel_length: 0.3 },
        },
      ],
      speedScale: 2,
      prePhonemeLength: 0.1,
      postPhonemeLength: 0.2,
    };

    expect(estimateAudioSeconds(query)).toBeCloseTo(0.65 / 2 + 0.3);
  });

  it('is just the edges for an empty query', () => {
    expect(estimateAudioSeconds({})).toBe(0);
  });
});

describe('synthesisTimeoutMs', () => {
  it.each([
    [0, 15_000],
    [6.6, 15_000],
    [7, 15_500],
    [18.1, 32_150],
    [Number.NaN, 15_000],
    [-5, 15_000],
  ])('%s s of audio -> %s ms', (seconds, expected) => {
    expect(synthesisTimeoutMs(seconds)).toBe(expected);
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
