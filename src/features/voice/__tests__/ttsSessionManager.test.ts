import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { AudioPlayer } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createAudioResource = vi.hoisted(() =>
  vi.fn((stream: unknown, options: unknown) => ({
    kind: 'resource',
    stream,
    options,
  }))
);

vi.mock('@discordjs/voice', () => ({
  AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
  StreamType: { Raw: 'raw' },
  createAudioResource,
}));

const connectionManager = vi.hoisted(() => ({
  getPlayer: vi.fn(),
  setSelfMute: vi.fn(() => true),
}));

vi.mock('../recording/connectionManager.js', () => ({ connectionManager }));

const getVoicevoxClient = vi.hoisted(() => vi.fn());

vi.mock('../tts/voicevoxClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tts/voicevoxClient.js')>()),
  getVoicevoxClient,
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const {
  FRAME_BYTES,
  MAX_FILL_MS,
  MAX_LINE_AGE_MS,
  MAX_QUEUE_LENGTH,
  OPUS_BITRATE,
  OPUS_COMPLEXITY,
  PREFETCH_COUNT,
  playPcm,
  TtsSessionManager,
  ttsSessions,
} = await import('../tts/sessionManager.js');
const { MAX_SPEECH_LENGTH } = await import('../tts/textNormalizer.js');
const { EDGE_SILENCE_SECONDS } = await import('../tts/voicevoxClient.js');
const { logger } = await import('../../../shared/utils/logger.js');

type SpeechRequest = Parameters<
  InstanceType<typeof TtsSessionManager>['enqueue']
>[1];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending promise chain settle (real timers only). */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const GUILD = 'guild-1';
const VC = 'vc-1';
const TEXT = 'text-1';

interface Render {
  kind: 'slice' | 'name';
  text: string;
  speakerId: number;
  speed: number;
  job: Deferred<Buffer>;
}

/**
 * A fake engine and player. Rendering and playback complete only when a
 * test says so (`auto: false`) or immediately (`auto: true`). Rendered audio
 * is the spoken text itself, so `played()` reads back what was heard, one
 * entry per line. `|` in a line marks where the engine's query would be cut
 * into slices; a name renders as `name、`.
 */
function harness({ auto = false } = {}) {
  const player = { stop: vi.fn() } as unknown as AudioPlayer & {
    stop: ReturnType<typeof vi.fn>;
  };
  const renders: Render[] = [];
  const plays: Array<{ text: string; ended: boolean; job: Deferred<void> }> =
    [];
  const state = {
    auto,
    now: 0,
    player: player as AudioPlayer | undefined,
    failText: null as string | null,
  };

  const render = (
    kind: Render['kind'],
    text: string,
    speakerId: number,
    speed: number
  ) => {
    const job = deferred<Buffer>();
    renders.push({ kind, text, speakerId, speed, job });
    if (state.failText !== null && text.includes(state.failText)) {
      job.reject(new Error(`engine choked on ${text}`));
    } else if (state.auto) {
      job.resolve(Buffer.from(text));
    }
    return job.promise;
  };

  const deps = {
    getPlayer: vi.fn(() => state.player),
    setSelfMute: vi.fn(() => true),
    prepare: vi.fn(async (text: string, speakerId: number, speed: number) =>
      text
        .split('|')
        .map((part) => () => render('slice', part, speakerId, speed))
    ),
    renderName: vi.fn((name: string, speakerId: number, speed: number) =>
      render('name', `${name}、`, speakerId, speed)
    ),
    initializeSpeaker: vi.fn(async (_speakerId: number) => true),
    play: vi.fn((_player: AudioPlayer, audio: AsyncIterable<Buffer>) => {
      const job = deferred<void>();
      const entry = { text: '', ended: false, job };
      plays.push(entry);
      void (async () => {
        for await (const pcm of audio) entry.text += pcm.toString();
        entry.ended = true;
        // A real player reports idle once the audio has run out.
        if (state.auto) job.resolve();
      })();
      return job.promise;
    }),
  };

  const manager = new TtsSessionManager(deps, () => state.now);

  return {
    deps,
    manager,
    player,
    state,
    renders,
    plays,
    /** Every slice and name the engine was asked to render, in order. */
    rendered: () => renders.map((r) => r.text),
    /** Lines whose text reached the engine (one audio_query each). */
    prepared: () => deps.prepare.mock.calls.map(([text]) => text),
    played: () => plays.map((p) => p.text),
    finish: (text: string) => {
      const r = renders.find((x) => x.text === text);
      if (!r) throw new Error(`${text} was never rendered`);
      r.job.resolve(Buffer.from(text));
    },
    start: (voiceChannelId = VC, guildId = GUILD, textChannelId = TEXT) =>
      manager.start({
        guildId,
        voiceChannelId,
        textChannelId,
        startedBy: 'starter',
      }),
  };
}

function line(
  text: string,
  overrides: Partial<SpeechRequest> = {}
): SpeechRequest {
  return {
    authorId: 'user-a',
    authorName: '',
    text,
    speakerId: 3,
    speed: 1,
    ...overrides,
  };
}

/** A line from its own author, so it is never merged with its neighbours. */
const solo = (text: string, overrides: Partial<SpeechRequest> = {}) =>
  line(text, { authorId: `author-${text}`, ...overrides });

describe('TtsSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sessions', () => {
    it('starts a session that reads the voice chat and the command channel', () => {
      const h = harness();
      h.state.now = 1234;

      const info = h.start();

      expect(info).toEqual({
        guildId: GUILD,
        voiceChannelId: VC,
        textChannelIds: new Set([VC, TEXT]),
        startedBy: 'starter',
        startedAt: 1234,
      });
      expect(h.manager.get(VC)).toBe(info);
      expect(h.manager.getForGuild(GUILD)).toBe(info);
    });

    it('unmutes when a session starts', () => {
      const h = harness();
      h.start();
      expect(h.deps.setSelfMute).toHaveBeenCalledTimes(1);
      expect(h.deps.setSelfMute).toHaveBeenCalledWith(VC, false);
    });

    it('adds a text channel to the running session without restarting it', () => {
      const h = harness();
      const first = h.start();

      const second = h.start(VC, GUILD, 'text-2');

      expect(second).toBe(first);
      expect([...second.textChannelIds].sort()).toEqual(
        [VC, TEXT, 'text-2'].sort()
      );
      expect(h.deps.setSelfMute).toHaveBeenCalledTimes(1);
    });

    it('keeps one session per guild: starting in another channel stops the first', () => {
      const h = harness();
      h.start('vc-a');
      h.start('vc-other-guild', 'guild-2');

      h.start('vc-b');

      expect(h.manager.get('vc-a')).toBeUndefined();
      expect(h.manager.get('vc-b')?.voiceChannelId).toBe('vc-b');
      expect(h.manager.getForGuild(GUILD)?.voiceChannelId).toBe('vc-b');
      // The first session was stopped properly: muted again and silenced.
      expect(h.deps.setSelfMute).toHaveBeenCalledWith('vc-a', true);
      expect(h.deps.getPlayer).toHaveBeenCalledWith('vc-a');
      // Other guilds are untouched.
      expect(h.manager.get('vc-other-guild')).toBeDefined();
    });

    it('stop re-mutes, stops the player and forgets the session', () => {
      const h = harness();
      h.start();
      h.deps.setSelfMute.mockClear();

      expect(h.manager.stop(VC)).toBe(true);

      expect(h.player.stop).toHaveBeenCalledWith(true);
      expect(h.deps.setSelfMute).toHaveBeenCalledWith(VC, true);
      expect(h.manager.get(VC)).toBeUndefined();
      expect(h.manager.getForGuild(GUILD)).toBeUndefined();
    });

    it('stop on an unknown channel does nothing', () => {
      const h = harness();
      expect(h.manager.stop('nope')).toBe(false);
      expect(h.deps.setSelfMute).not.toHaveBeenCalled();
      expect(h.deps.getPlayer).not.toHaveBeenCalled();
    });

    it('handleDisconnect drops the session without touching mute', () => {
      const h = harness();
      h.start();
      h.deps.setSelfMute.mockClear();

      h.manager.handleDisconnect(VC);

      expect(h.manager.get(VC)).toBeUndefined();
      expect(h.deps.setSelfMute).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('ended with the connection')
      );
    });

    it('handleDisconnect for a channel without a session is silent', () => {
      const h = harness();
      h.manager.handleDisconnect('nope');
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('stopAll ends every session without touching mute', () => {
      const h = harness();
      h.start('vc-a', 'guild-a');
      h.start('vc-b', 'guild-b');
      h.deps.setSelfMute.mockClear();

      h.manager.stopAll();

      expect(h.manager.get('vc-a')).toBeUndefined();
      expect(h.manager.get('vc-b')).toBeUndefined();
      expect(h.deps.setSelfMute).not.toHaveBeenCalled();
    });

    it('finds the session for its voice chat and text channels only', () => {
      const h = harness();
      const info = h.start();

      expect(h.manager.findForTextChannel(GUILD, VC)).toBe(info);
      expect(h.manager.findForTextChannel(GUILD, TEXT)).toBe(info);
      expect(h.manager.findForTextChannel(GUILD, 'elsewhere')).toBeUndefined();
      expect(h.manager.findForTextChannel('guild-2', TEXT)).toBeUndefined();
    });
  });

  describe('enqueue', () => {
    it('refuses lines for a channel without a session', () => {
      const h = harness();
      expect(h.manager.enqueue(VC, line('hello'))).toBe(false);
      expect(h.deps.prepare).not.toHaveBeenCalled();
      expect(h.manager.queueLength(VC)).toBe(0);
    });

    it('plays lines in order with each request’s voice and speed', async () => {
      const h = harness({ auto: true });
      h.start();

      h.manager.enqueue(VC, line('one', { speakerId: 1, speed: 0.8 }));
      h.manager.enqueue(VC, line('two', { speakerId: 2, speed: 1.5 }));
      h.manager.enqueue(VC, line('three'));
      await flush();

      expect(h.played()).toEqual(['one', 'two', 'three']);
      expect(
        h.renders.map(({ text, speakerId, speed }) => [text, speakerId, speed])
      ).toEqual([
        ['one', 1, 0.8],
        ['two', 2, 1.5],
        ['three', 3, 1],
      ]);
      expect(h.deps.prepare).toHaveBeenCalledWith('one', 1, 0.8);
      expect(h.deps.play).toHaveBeenCalledWith(h.player, expect.anything());
      expect(h.manager.queueLength(VC)).toBe(0);
    });

    describe('name announcements', () => {
      it('announces the first speaker and every change of speaker', async () => {
        const h = harness({ auto: true });
        h.start();
        const a = { authorId: 'a', authorName: 'あい' };
        const b = { authorId: 'b', authorName: 'びー' };

        h.manager.enqueue(VC, line('1', a));
        h.manager.enqueue(VC, line('2', a));
        h.manager.enqueue(VC, line('3', b));
        h.manager.enqueue(VC, line('4', a));
        await flush();

        expect(h.played()).toEqual(['あい、1', '2', 'びー、3', 'あい、4']);
      });

      it('re-announces only after more than 60s since that speaker’s last line', async () => {
        const h = harness({ auto: true });
        h.start();
        const a = { authorId: 'a', authorName: 'あい' };

        h.manager.enqueue(VC, line('1', a));
        h.state.now = 60_000;
        h.manager.enqueue(VC, line('2', a)); // exactly 60s: not yet
        h.state.now = 120_000;
        h.manager.enqueue(VC, line('3', a)); // 60s after line 2: not yet
        h.state.now = 180_001;
        h.manager.enqueue(VC, line('4', a)); // 60.001s of silence
        await flush();

        expect(h.played()).toEqual(['あい、1', '2', '3', 'あい、4']);
      });

      it('never announces an empty name', async () => {
        const h = harness({ auto: true });
        h.start();

        h.manager.enqueue(VC, line('1', { authorId: 'a', authorName: '' }));
        h.manager.enqueue(VC, line('2', { authorId: 'b', authorName: '' }));
        await flush();

        expect(h.played()).toEqual(['1', '2']);
        expect(h.deps.renderName).not.toHaveBeenCalled();
      });

      it('renders a name on its own, with the line’s voice and speed', async () => {
        const h = harness({ auto: true });
        h.start();

        h.manager.enqueue(
          VC,
          line('こんにちは', { authorName: 'あい', speakerId: 8, speed: 1.4 })
        );
        await flush();

        expect(h.deps.renderName).toHaveBeenCalledWith('あい', 8, 1.4);
        expect(h.deps.prepare).toHaveBeenCalledWith('こんにちは', 8, 1.4);
        expect(h.played()).toEqual(['あい、こんにちは']);
      });

      it('plays a name again from the cache instead of rendering it again', async () => {
        const h = harness({ auto: true });
        h.start();
        const a = { authorId: 'a', authorName: 'あい' };
        const b = { authorId: 'b', authorName: 'びー' };

        // People take turns a few seconds apart.
        h.manager.enqueue(VC, line('1', a));
        await flush();
        h.manager.enqueue(VC, line('2', b));
        await flush();
        h.manager.enqueue(VC, line('3', a));
        await flush();

        expect(h.played()).toEqual(['あい、1', 'びー、2', 'あい、3']);
        expect(h.deps.renderName.mock.calls.map(([name]) => name)).toEqual([
          'あい',
          'びー',
        ]);
      });

      it('renders the name again for a different voice', async () => {
        const h = harness({ auto: true });
        h.start();
        const a = { authorId: 'a', authorName: 'あい' };
        const b = { authorId: 'b', authorName: 'びー' };

        h.manager.enqueue(VC, line('1', a));
        await flush();
        h.manager.enqueue(VC, line('2', b));
        await flush();
        h.manager.enqueue(VC, line('3', { ...a, speakerId: 2 }));
        await flush();

        expect(h.deps.renderName).toHaveBeenCalledTimes(3);
        expect(h.deps.renderName).toHaveBeenLastCalledWith('あい', 2, 1);
      });

      it('holds a cached name until the engine is working on the line’s text', async () => {
        const h = harness({ auto: true });
        h.start('vc-b', 'guild-b');
        const x = { authorId: 'x', authorName: 'えっくす' };
        h.manager.enqueue('vc-b', line('hello', x)); // caches えっくす
        h.manager.enqueue('vc-b', solo('quiet')); // someone else speaks
        await flush();
        expect(h.played()).toEqual(['えっくす、hello', 'quiet']);

        // Another server holds the engine; x speaks again in vc-b.
        h.state.auto = false;
        h.start('vc-a', 'guild-a');
        h.manager.enqueue('vc-a', solo('A1'));
        await flush();
        h.manager.enqueue('vc-b', line('again', x));
        await flush();
        // The name is ready, but the text has not reached the engine.
        expect(h.plays).toHaveLength(2);

        h.finish('A1');
        await flush();
        // The engine is on the text now: the name plays while it renders.
        expect(h.plays).toHaveLength(4);
        expect(h.played()).toContain('えっくす、');
        h.finish('again');
        await flush();
        expect(h.played()).toContain('えっくす、again');
        expect(h.deps.renderName).toHaveBeenCalledTimes(1);
      });

      it('leaves out a name that cannot be rendered and still reads the line', async () => {
        const h = harness({ auto: true });
        h.state.failText = 'あい';
        h.start();

        h.manager.enqueue(VC, line('こんにちは', { authorName: 'あい' }));
        await flush();

        expect(h.played()).toEqual(['こんにちは']);
        expect(logger.warn).toHaveBeenCalledWith(
          'TTS name synthesis failed: engine choked on あい、'
        );
      });

      it('still announces a speaker whose previous, announced line was dropped', async () => {
        const h = harness();
        h.start();
        const a = { authorId: 'a', authorName: 'えー' };

        h.manager.enqueue(VC, solo('L1')); // rendering, holds the engine
        h.manager.enqueue(VC, solo('L2'));
        h.manager.enqueue(VC, solo('L3'));
        h.manager.enqueue(VC, line('old', a)); // would have announced えー
        h.state.now = MAX_LINE_AGE_MS + 1;
        // Another voice, so it is not merged into the old line.
        h.manager.enqueue(VC, line('new', { ...a, speakerId: 2 }));

        await flush();
        h.state.auto = true;
        h.finish('L1');
        for (let i = 0; i < 5; i++) {
          await flush();
          for (const p of h.plays) p.job.resolve();
        }
        await flush();

        expect(h.played()).toEqual(['L1', 'L2', 'L3', 'えー、new']);
        expect(h.prepared()).not.toContain('old');
      });
    });

    describe('names while the engine is failing', () => {
      const taro = { authorId: 'taro', authorName: 'たろう' };
      const hana = { authorId: 'hana', authorName: 'はなこ' };

      /** Both names are cached, as on a server that has been chatting. */
      async function warmedUp() {
        const h = harness({ auto: true });
        h.start();
        h.manager.enqueue(VC, line('hello', taro));
        await flush();
        h.manager.enqueue(VC, line('hi', hana));
        await flush();
        expect(h.played()).toEqual(['たろう、hello', 'はなこ、hi']);
        return h;
      }

      it('never reads out a cached name alone once lines have been failing', async () => {
        const h = await warmedUp();
        h.state.failText = 'down';

        // The first failure cannot be foreseen: the name was already heard.
        h.manager.enqueue(VC, line('down1', taro));
        await flush();
        expect(h.played().at(-1)).toBe('たろう、');

        // From then on a name waits for its text, and goes with it.
        h.manager.enqueue(VC, line('down2', hana));
        await flush();
        h.manager.enqueue(VC, line('down3', taro));
        await flush();
        expect(h.played()).toHaveLength(3);
        expect(h.prepared()).toContain('down3');
      });

      it('plays a held name together with its text once the engine answers again', async () => {
        const h = await warmedUp();
        h.state.failText = 'down';
        h.manager.enqueue(VC, line('down1', taro));
        await flush();
        h.state.failText = null;
        h.state.auto = false;

        h.manager.enqueue(VC, line('back', hana));
        await flush();
        // The name is cached, but it waits for the text this time.
        expect(h.plays).toHaveLength(3);

        h.finish('back');
        await flush();
        expect(h.played().at(-1)).toBe('はなこ、back');

        // Healthy again: the next cached name plays while its text renders.
        h.plays.at(-1)!.job.resolve();
        h.manager.enqueue(VC, line('fast', taro));
        await flush();
        expect(h.played().at(-1)).toBe('たろう、');
        h.finish('fast');
        await flush();
        expect(h.played().at(-1)).toBe('たろう、fast');
      });

      it('counts a line that ended before its text arrived as a failure', async () => {
        const h = await warmedUp();
        h.state.auto = false;

        // The engine stalls: the name plays, the text never comes, and
        // playback gives up on the line.
        h.manager.enqueue(VC, line('stalled', taro));
        await flush();
        expect(h.played().at(-1)).toBe('たろう、');
        h.plays.at(-1)!.job.resolve();
        await flush();
        h.finish('stalled'); // far too late; the result is thrown away
        await flush();

        h.manager.enqueue(VC, line('later', hana));
        await flush();
        expect(h.plays).toHaveLength(3);
        expect(h.played().at(-1)).toBe('たろう、');
      });

      it('does not count a skipped line as a failure', async () => {
        const h = await warmedUp();
        h.state.auto = false;

        h.manager.enqueue(VC, line('long', taro));
        await flush();
        expect(h.manager.skip(VC)).toBe(true);
        h.plays.at(-1)!.job.resolve();
        h.finish('long'); // the engine finishes the abandoned request
        await flush();

        h.manager.enqueue(VC, line('next', hana));
        await flush();
        // The engine is not to blame: the cached name plays at once.
        expect(h.played().at(-1)).toBe('はなこ、');
      });
    });

    describe('merging a speaker’s waiting lines', () => {
      /** L1 renders and L2, L3 are with the engine: later lines wait. */
      function busy() {
        const h = harness();
        h.start();
        h.manager.enqueue(VC, solo('L1'));
        h.manager.enqueue(VC, solo('L2'));
        h.manager.enqueue(VC, solo('L3'));
        return h;
      }

      async function drain(h: ReturnType<typeof harness>) {
        h.state.auto = true;
        for (const r of [...h.renders]) r.job.resolve(Buffer.from(r.text));
        for (let i = 0; i < 6; i++) {
          await flush();
          for (const p of h.plays) p.job.resolve();
        }
        await flush();
      }

      it('reads two waiting lines from the same speaker and voice as one, with one name', async () => {
        const h = busy();
        const a = { authorId: 'a', authorName: 'あい' };

        h.manager.enqueue(VC, line('おはよう', a));
        h.manager.enqueue(VC, line('元気？', a));
        expect(h.manager.queueLength(VC)).toBe(3);
        await drain(h);

        expect(h.prepared()).toEqual(['L1', 'L2', 'L3', 'おはよう、元気？']);
        expect(h.played().at(-1)).toBe('あい、おはよう、元気？');
        expect(h.deps.renderName).toHaveBeenCalledTimes(1);
      });

      it.each<[string, Partial<SpeechRequest>]>([
        ['another speaker', { authorId: 'b' }],
        ['another voice', { speakerId: 2 }],
        ['another speed', { speed: 1.5 }],
        ['a voice preview', { mergeable: false }],
      ])('keeps a line from %s separate', async (_label, change) => {
        const h = busy();

        h.manager.enqueue(VC, line('one', { authorId: 'a' }));
        h.manager.enqueue(VC, line('two', { authorId: 'a', ...change }));
        await drain(h);

        expect(h.prepared().slice(-2)).toEqual(['one', 'two']);
      });

      it('never merges into a line already handed to the engine', async () => {
        const h = harness();
        h.start();

        h.manager.enqueue(VC, line('one'));
        h.manager.enqueue(VC, line('two'));
        await drain(h);

        expect(h.prepared()).toEqual(['one', 'two']);
      });

      it(`keeps a message separate when merging would go over ${MAX_SPEECH_LENGTH} characters`, async () => {
        const h = busy();

        h.manager.enqueue(VC, line('あ'.repeat(60)));
        h.manager.enqueue(VC, line('い'.repeat(60)));
        await drain(h);

        // Both are read in full; merging would have cut 21 characters.
        expect(h.prepared().slice(-2)).toEqual([
          'あ'.repeat(60),
          'い'.repeat(60),
        ]);
      });

      it('never reads a stale message merged with a new one: the new one is read alone', async () => {
        const h = busy();
        const a = { authorId: 'a', authorName: 'あい' };

        h.manager.enqueue(VC, line('OLD', a)); // posted at 0, waits
        h.state.now = MAX_LINE_AGE_MS + 1;
        h.manager.enqueue(VC, line('new', a));
        await drain(h);

        expect(h.prepared()).toEqual(['L1', 'L2', 'L3', 'new']);
        expect(h.played().at(-1)).toBe('あい、new');
      });

      it('forgets stale lines as soon as a new message arrives', async () => {
        const h = busy();

        h.manager.enqueue(VC, solo('OLD'));
        h.state.now = MAX_LINE_AGE_MS + 1;
        h.manager.enqueue(VC, solo('new'));

        // L2, L3 (with the engine) and new; OLD no longer counts as waiting.
        expect(h.manager.queueLength(VC)).toBe(3);
        await drain(h);
        expect(h.prepared()).toEqual(['L1', 'L2', 'L3', 'new']);
      });

      it('drops only the stale messages of a merged line, never the fresh ones', async () => {
        const h = busy();
        const a = { authorId: 'a', authorName: 'あい' };

        // A chatty speaker keeps adding to one waiting line.
        h.manager.enqueue(VC, line('one', a));
        h.state.now = 10_000;
        h.manager.enqueue(VC, line('two', a));
        h.state.now = 20_000;
        h.manager.enqueue(VC, line('three', a));
        expect(h.manager.queueLength(VC)).toBe(3);

        // Handed to the engine once 'one' is past the limit.
        h.state.now = MAX_LINE_AGE_MS + 1;
        await drain(h);

        expect(h.prepared().at(-1)).toBe('two、three');
        expect(h.played().at(-1)).toBe('あい、two、three');
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('dropped 1 message(s) older than 25s')
        );
      });

      it('keeps a merged line whose messages are all fresh whole', async () => {
        const h = busy();

        h.manager.enqueue(VC, line('one'));
        h.state.now = 20_000;
        h.manager.enqueue(VC, line('two'));
        h.state.now = MAX_LINE_AGE_MS; // 'one' exactly at the limit
        await drain(h);

        expect(h.prepared().at(-1)).toBe('one、two');
      });

      it('does not read on after a line that was already cut', async () => {
        const h = busy();
        const cut = `${'あ'.repeat(MAX_SPEECH_LENGTH)}、以下略`;

        h.manager.enqueue(VC, line(cut));
        h.manager.enqueue(VC, line('つづき'));
        await drain(h);

        expect(h.prepared().slice(-2)).toEqual([cut, 'つづき']);
      });
    });

    describe('backlog limits', () => {
      it(`caps the queue at ${MAX_QUEUE_LENGTH}, dropping the oldest line not yet with the engine`, async () => {
        const h = harness();
        h.start();

        h.manager.enqueue(VC, solo('L1')); // taken off the queue at once
        for (let i = 2; i <= MAX_QUEUE_LENGTH + 2; i++) {
          h.manager.enqueue(VC, solo(`L${i}`));
        }
        await flush();
        expect(h.manager.queueLength(VC)).toBe(MAX_QUEUE_LENGTH);
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('dropped oldest line')
        );
        // Only one request is with the engine; the rest wait their turn.
        expect(h.rendered()).toEqual(['L1']);

        // Let everything through.
        h.state.auto = true;
        h.finish('L1');
        for (let i = 0; i < MAX_QUEUE_LENGTH + 2; i++) {
          await flush();
          for (const p of h.plays) p.job.resolve();
        }
        await flush();

        // L2 and L3 were already with the engine; L4 was the oldest waiting.
        const expected = ['L1', 'L2', 'L3'];
        for (let i = 5; i <= MAX_QUEUE_LENGTH + 2; i++) expected.push(`L${i}`);
        expect(h.played()).toEqual(expected);
        expect(h.prepared()).not.toContain('L4');
      });

      it('sends a flood to the engine no faster than it can render', async () => {
        const h = harness();
        h.start();

        for (let i = 1; i <= 15; i++) h.manager.enqueue(VC, solo(`L${i}`));
        await flush();

        expect(h.deps.prepare.mock.calls.length).toBeLessThanOrEqual(
          PREFETCH_COUNT + 1
        );
      });

      it('hands at most two lines to the engine ahead of the one being played', async () => {
        const h = harness();
        h.start();
        for (const text of ['L1', 'L2', 'L3', 'L4', 'L5']) {
          h.manager.enqueue(VC, solo(text));
        }
        await flush();
        expect(h.rendered()).toEqual(['L1']);

        // L1 is ready and starts playing; L2 and L3 render meanwhile.
        h.finish('L1');
        await flush();
        expect(h.played()).toEqual(['L1']);
        h.finish('L2');
        await flush();
        h.finish('L3');
        await flush();
        expect(h.rendered()).toEqual(['L1', 'L2', 'L3']);

        // L1 ends; L2 plays and L4 is handed to the engine.
        h.plays[0].job.resolve();
        await flush();
        expect(h.played()).toEqual(['L1', 'L2']);
        expect(h.rendered()).toEqual(['L1', 'L2', 'L3', 'L4']);
      });

      it(`never renders a line still waiting ${MAX_LINE_AGE_MS / 1000}s after it was posted`, async () => {
        const h = harness();
        h.start();
        h.manager.enqueue(VC, solo('L1'));
        h.manager.enqueue(VC, solo('L2'));
        h.manager.enqueue(VC, solo('L3'));
        h.manager.enqueue(VC, solo('stale')); // posted at 0
        h.state.now = 1;
        h.manager.enqueue(VC, solo('boundary')); // posted at 1
        await flush();

        // stale is now just over the limit; boundary exactly at it.
        h.state.now = MAX_LINE_AGE_MS + 1;
        h.manager.enqueue(VC, solo('fresh'));
        h.state.auto = true;
        h.finish('L1');
        for (let i = 0; i < 6; i++) {
          await flush();
          for (const p of h.plays) p.job.resolve();
        }

        expect(h.prepared()).toEqual(['L1', 'L2', 'L3', 'boundary', 'fresh']);
        expect(h.played()).toEqual(['L1', 'L2', 'L3', 'boundary', 'fresh']);
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('older than 25s')
        );
      });

      it('never drops a line already with the engine, however long it waits', async () => {
        const h = harness();
        h.start();
        h.manager.enqueue(VC, solo('L1'));
        h.manager.enqueue(VC, solo('L2'));
        await flush();
        h.finish('L1');
        await flush();
        h.finish('L2');
        await flush();

        // L1 plays for a minute; L2 has been ready all along.
        h.state.now = 60_000;
        h.plays[0].job.resolve();
        await flush();

        expect(h.played()).toEqual(['L1', 'L2']);
      });

      it('takes turns with other sessions: one busy chat cannot hold up another', async () => {
        const h = harness();
        h.start('vc-a', 'guild-a');
        h.start('vc-b', 'guild-b');
        for (const text of ['A1', 'A2', 'A3']) {
          h.manager.enqueue('vc-a', solo(text));
        }
        h.manager.enqueue('vc-b', solo('B1'));
        await flush();

        for (const text of ['A1', 'B1', 'A2', 'A3']) {
          h.finish(text);
          await flush();
        }

        expect(h.rendered()).toEqual(['A1', 'B1', 'A2', 'A3']);
      });

      it('renders the rest of a line before another session goes a second time', async () => {
        const h = harness();
        h.start('vc-a', 'guild-a');
        h.start('vc-b', 'guild-b');
        h.manager.enqueue('vc-a', solo('a1|a2|a3'));
        await flush();
        h.manager.enqueue('vc-b', solo('B1'));
        h.manager.enqueue('vc-b', solo('B2'));
        await flush();

        for (const text of ['a1', 'B1', 'a2', 'a3', 'B2']) {
          h.finish(text);
          await flush();
        }

        // B goes once between a's first slice and the rest, not per slice.
        expect(h.rendered()).toEqual(['a1', 'B1', 'a2', 'a3', 'B2']);
      });

      it('renders a new name and its line as one turn', async () => {
        const h = harness();
        h.start('vc-a', 'guild-a');
        h.start('vc-b', 'guild-b');
        h.manager.enqueue('vc-a', line('a1|a2', { authorName: 'えー' }));
        await flush();
        h.manager.enqueue('vc-b', solo('B1'));
        h.manager.enqueue('vc-b', solo('B2'));
        await flush();

        for (const text of ['えー、', 'B1', 'a1', 'a2', 'B2']) {
          h.finish(text);
          await flush();
        }

        expect(h.rendered()).toEqual(['えー、', 'B1', 'a1', 'a2', 'B2']);
      });
    });

    describe('slices', () => {
      it('renders a line’s slices in order from one query and plays them as one line', async () => {
        const h = harness({ auto: true });
        h.start();

        h.manager.enqueue(VC, line('一つ目、|二つ目、|三つ目'));
        await flush();

        expect(h.deps.prepare).toHaveBeenCalledTimes(1);
        expect(h.rendered()).toEqual(['一つ目、', '二つ目、', '三つ目']);
        expect(h.played()).toEqual(['一つ目、二つ目、三つ目']);
      });

      it('starts playing as soon as the first slice is ready', async () => {
        const h = harness();
        h.start();

        h.manager.enqueue(VC, line('a|b|c'));
        await flush();
        expect(h.rendered()).toEqual(['a']);
        expect(h.deps.play).not.toHaveBeenCalled();

        h.finish('a');
        await flush();
        expect(h.played()).toEqual(['a']);
        expect(h.rendered()).toEqual(['a', 'b']);

        h.finish('b');
        await flush();
        h.finish('c');
        await flush();
        expect(h.played()).toEqual(['abc']);
        expect(h.plays[0].ended).toBe(true);
      });

      it('renders the rest of a line before the next line', async () => {
        const h = harness({ auto: true });
        h.start();

        h.manager.enqueue(VC, solo('a|b'));
        h.manager.enqueue(VC, solo('c'));
        await flush();

        expect(h.rendered()).toEqual(['a', 'b', 'c']);
        expect(h.played()).toEqual(['ab', 'c']);
      });

      it('plays what rendered when a later slice fails, then carries on', async () => {
        const h = harness({ auto: true });
        h.state.failText = 'bad';
        h.start();

        h.manager.enqueue(VC, solo('ok|bad|never'));
        h.manager.enqueue(VC, solo('next'));
        await flush();

        expect(h.played()).toEqual(['ok', 'next']);
        expect(h.rendered()).not.toContain('never');
        expect(logger.warn).toHaveBeenCalledWith(
          'TTS synthesis failed: engine choked on bad'
        );
      });

      it('skipping mid-line cancels the slices not yet rendered', async () => {
        const h = harness();
        h.start();
        h.manager.enqueue(VC, solo('a|b|c'));
        h.manager.enqueue(VC, solo('next'));
        await flush();
        h.finish('a');
        await flush();
        expect(h.rendered()).toEqual(['a', 'b']);

        expect(h.manager.skip(VC)).toBe(true);
        expect(h.player.stop).toHaveBeenCalledWith(true);
        h.finish('b');
        h.plays[0].job.resolve();
        h.state.auto = true;
        await flush();

        expect(h.rendered()).toEqual(['a', 'b', 'next']);
        expect(h.played()).toEqual(['a', 'next']);
      });
    });

    it('skips a line whose synthesis fails and carries on', async () => {
      const h = harness({ auto: true });
      h.state.failText = 'bad';
      h.start();

      h.manager.enqueue(VC, solo('good 1'));
      h.manager.enqueue(VC, solo('bad'));
      h.manager.enqueue(VC, solo('good 2'));
      await flush();

      expect(h.played()).toEqual(['good 1', 'good 2']);
      expect(logger.warn).toHaveBeenCalledWith(
        'TTS synthesis failed: engine choked on bad'
      );
    });

    it('skips a line whose query fails and carries on', async () => {
      const h = harness({ auto: true });
      h.deps.prepare.mockImplementationOnce(async () => {
        throw new Error('audio_query returned 500');
      });
      h.start();

      h.manager.enqueue(VC, solo('lost'));
      h.manager.enqueue(VC, solo('kept'));
      await flush();

      expect(h.played()).toEqual(['kept']);
      expect(logger.warn).toHaveBeenCalledWith(
        'TTS synthesis failed: audio_query returned 500'
      );
    });

    it('keeps playing the rest of the queue when one clip fails to play', async () => {
      const h = harness({ auto: true });
      h.deps.play.mockImplementationOnce(() => {
        throw new Error('player.play threw');
      });
      h.start();

      h.manager.enqueue(VC, solo('one'));
      h.manager.enqueue(VC, solo('two'));
      h.manager.enqueue(VC, solo('three'));
      await flush();

      expect(h.deps.play).toHaveBeenCalledTimes(3);
      expect(h.played()).toEqual(['two', 'three']);
      expect(logger.warn).toHaveBeenCalledWith(
        'TTS playback failed: player.play threw'
      );
      expect(h.manager.queueLength(VC)).toBe(0);
    });

    it('skips a line that renders to no audio', async () => {
      const h = harness();
      h.start();

      h.manager.enqueue(VC, solo('silent'));
      h.manager.enqueue(VC, solo('loud'));
      await flush();
      h.renders[0].job.resolve(Buffer.alloc(0));
      await flush();
      h.finish('loud');
      await flush();

      expect(h.played()).toEqual(['loud']);
    });

    it('ends the session when the connection has no player', async () => {
      const h = harness({ auto: true });
      h.start();
      h.state.player = undefined;
      h.deps.setSelfMute.mockClear();

      h.manager.enqueue(VC, solo('hello'));
      h.manager.enqueue(VC, solo('again'));
      await flush();

      expect(h.deps.play).not.toHaveBeenCalled();
      expect(h.manager.get(VC)).toBeUndefined();
      // The connection is gone; there is nothing to re-mute.
      expect(h.deps.setSelfMute).not.toHaveBeenCalled();
    });
  });

  describe('skip', () => {
    it('is refused when there is no session', () => {
      const h = harness();
      expect(h.manager.skip(VC)).toBe(false);
      expect(h.player.stop).not.toHaveBeenCalled();
    });

    it('is refused when nothing is being read', async () => {
      const h = harness({ auto: true });
      h.start();
      h.manager.enqueue(VC, line('done'));
      await flush();
      h.player.stop.mockClear();

      expect(h.manager.skip(VC)).toBe(false);
      expect(h.player.stop).not.toHaveBeenCalled();
    });

    it('stops the line being played and lets the queue continue', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, solo('long'));
      h.manager.enqueue(VC, solo('next'));
      await flush();
      h.finish('long');
      await flush();
      h.finish('next');
      await flush();
      expect(h.played()).toEqual(['long']);

      expect(h.manager.skip(VC)).toBe(true);
      expect(h.player.stop).toHaveBeenCalledWith(true);

      // A stopped player reports idle, which ends the play() promise.
      h.plays[0].job.resolve();
      await flush();
      expect(h.played()).toEqual(['long', 'next']);
      expect(h.manager.get(VC)).toBeDefined();
    });

    it('never plays a line skipped while it is still being rendered', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, solo('skipped'));
      h.manager.enqueue(VC, solo('kept'));
      await flush();

      expect(h.manager.skip(VC)).toBe(true);

      h.finish('skipped');
      await flush();
      expect(h.deps.play).not.toHaveBeenCalled();

      h.finish('kept');
      await flush();
      expect(h.played()).toEqual(['kept']);
    });

    it('never sends the engine a line skipped while it waited its turn', async () => {
      const h = harness();
      h.start('vc-a', 'guild-a');
      h.start('vc-b', 'guild-b');
      h.manager.enqueue('vc-a', solo('A1')); // holds the engine
      h.manager.enqueue('vc-b', solo('B1')); // waits behind it
      await flush();

      expect(h.manager.skip('vc-b')).toBe(true);
      h.finish('A1');
      await flush();

      expect(h.prepared()).toEqual(['A1']);
    });
  });

  describe('stopping mid-queue', () => {
    it('plays nothing more after stop, even when the current clip ends', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, solo('L1'));
      h.manager.enqueue(VC, solo('L2'));
      h.manager.enqueue(VC, solo('L3'));
      await flush();
      h.finish('L1');
      await flush();
      expect(h.played()).toEqual(['L1']);

      h.manager.stop(VC);
      expect(h.manager.queueLength(VC)).toBe(0);
      h.state.auto = true;
      h.plays[0].job.resolve();
      await flush();

      expect(h.played()).toEqual(['L1']);
      expect(h.manager.enqueue(VC, line('late'))).toBe(false);
    });

    it('sends the engine nothing more for a stopped session', async () => {
      const h = harness();
      h.start();
      for (const text of ['L1', 'L2', 'L3']) h.manager.enqueue(VC, solo(text));
      await flush();
      expect(h.rendered()).toEqual(['L1']);

      h.manager.stop(VC);
      h.state.auto = true;
      h.finish('L1');
      await flush();

      expect(h.rendered()).toEqual(['L1']);
      expect(h.deps.play).not.toHaveBeenCalled();
    });

    it('keeps an old queue from leaking into a restarted session', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, line('old'));
      await flush();
      h.manager.stop(VC);

      h.start();
      h.manager.enqueue(VC, line('new'));
      await flush();
      h.finish('old');
      await flush();
      h.finish('new');
      await flush();

      expect(h.played()).toEqual(['new']);
    });
  });

  describe('warmUp', () => {
    it('loads each distinct voice once', async () => {
      const h = harness();

      h.manager.warmUp([3, 8, 3]);
      await flush();

      expect(
        h.deps.initializeSpeaker.mock.calls.map(([id]) => id).sort()
      ).toEqual([3, 8]);
    });

    it('waits behind lines already waiting for the engine', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, solo('L1'));
      await flush();

      h.manager.warmUp([8]);
      h.manager.enqueue(VC, solo('L2'));
      await flush();
      expect(h.deps.initializeSpeaker).not.toHaveBeenCalled();

      h.finish('L1');
      await flush();
      h.finish('L2');
      await flush();
      expect(h.deps.initializeSpeaker).toHaveBeenCalledWith(8);
      expect(h.rendered()).toEqual(['L1', 'L2']);
    });

    it('shrugs off a failed warm-up', async () => {
      const h = harness();
      h.deps.initializeSpeaker.mockRejectedValueOnce(new Error('cold'));

      h.manager.warmUp([8]);
      await flush();

      expect(logger.debug).toHaveBeenCalledWith(
        'TTS voice 8 warm-up failed: cold'
      );
    });
  });
});

/** A player that behaves like @discordjs/voice's for listener bookkeeping. */
class FakePlayer extends EventEmitter {
  readonly play = vi.fn();
  readonly stop = vi.fn();
}

async function readAll(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return chunks;
}

type FakeResource = { stream: Readable; options: unknown; encoder?: unknown };

function lastResource(): FakeResource {
  return createAudioResource.mock.results.at(-1)!.value as FakeResource;
}

/** Every chunk the stream emits, as an encoder piped to it receives them. */
function collect(stream: Readable): Buffer[] {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return chunks;
}

async function collectAll(stream: Readable): Promise<Buffer[]> {
  const chunks = collect(stream);
  await new Promise((resolve) => stream.once('end', resolve));
  return chunks;
}

describe('playPcm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // setImmediate stays real so streams can be drained between steps.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays the PCM as a raw resource in 20 ms frames and resolves when the player goes idle', async () => {
    const player = new FakePlayer();
    // One second of 48 kHz stereo s16le: 50 frames.
    const pcm = Buffer.alloc(192_000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
    let done = false;

    const playing = playPcm(player as unknown as AudioPlayer, pcm).then(() => {
      done = true;
    });

    expect(createAudioResource).toHaveBeenCalledWith(expect.any(Readable), {
      inputType: 'raw',
    });
    const resource = lastResource();
    expect(player.play).toHaveBeenCalledWith(resource);
    const chunks = await collectAll(resource.stream);
    expect(chunks).toHaveLength(50);
    expect(chunks.every((chunk) => chunk.length === FRAME_BYTES)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(pcm);

    await flush();
    expect(done).toBe(false);

    player.emit('idle');
    await playing;
    expect(done).toBe(true);
    expect(player.listenerCount('idle')).toBe(0);
    expect(player.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a final partial frame', async () => {
    const player = new FakePlayer();
    const pcm = Buffer.alloc(FRAME_BYTES + 4, 7);

    void playPcm(player as unknown as AudioPlayer, pcm);
    const chunks = await collectAll(lastResource().stream);

    expect(chunks.map((c) => c.length)).toEqual([FRAME_BYTES, 4]);
  });

  it('builds the resource without encoding the clip up front', () => {
    const player = new FakePlayer();
    const tenSeconds = Buffer.alloc(1_920_000);

    void playPcm(player as unknown as AudioPlayer, tenSeconds);

    // Nothing has been read yet: frames are produced as the player pulls.
    expect(lastResource().stream.readableLength).toBe(0);
  });

  it('resolves on a player error and cleans up', async () => {
    const player = new FakePlayer();

    const playing = playPcm(player as unknown as AudioPlayer, Buffer.alloc(4));
    player.emit('error', new Error('encoder exploded'));
    await playing;

    expect(logger.debug).toHaveBeenCalledWith(
      'TTS playback error: encoder exploded'
    );
    expect(player.listenerCount('idle')).toBe(0);
    expect(player.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(lastResource().stream.destroyed).toBe(true);
  });

  it('gives up 5s after the clip should have ended if the player never idles', async () => {
    const player = new FakePlayer();
    // One second of 48 kHz stereo s16le.
    const pcm = Buffer.alloc(192_000);
    let done = false;

    void playPcm(player as unknown as AudioPlayer, pcm).then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(5_999);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(player.listenerCount('idle')).toBe(0);
    expect(lastResource().stream.destroyed).toBe(true);
  });

  describe('speech encoding', () => {
    it(`sets ${OPUS_BITRATE / 1000} kbps and complexity ${OPUS_COMPLEXITY} on the encoder`, () => {
      const encoderCTL = vi.fn();
      const setBitrate = vi.fn();
      createAudioResource.mockImplementationOnce((stream, options) => ({
        kind: 'resource',
        stream,
        options,
        encoder: { setBitrate, encoder: { encoderCTL } },
      }));

      void playPcm(new FakePlayer() as unknown as AudioPlayer, Buffer.alloc(4));

      expect(setBitrate).toHaveBeenCalledWith(64_000);
      // OPUS_SET_COMPLEXITY_REQUEST
      expect(encoderCTL).toHaveBeenCalledWith(4010, 5);
    });

    it('uses the native encoder’s own control call when it has one', () => {
      const applyEncoderCTL = vi.fn();
      const encoderCTL = vi.fn();
      createAudioResource.mockImplementationOnce((stream, options) => ({
        kind: 'resource',
        stream,
        options,
        encoder: {
          setBitrate: vi.fn(),
          encoder: { applyEncoderCTL, encoderCTL },
        },
      }));

      void playPcm(new FakePlayer() as unknown as AudioPlayer, Buffer.alloc(4));

      expect(applyEncoderCTL).toHaveBeenCalledWith(4010, 5);
      expect(encoderCTL).not.toHaveBeenCalled();
    });

    it('plays anyway when the encoder refuses a setting', () => {
      const player = new FakePlayer();
      createAudioResource.mockImplementationOnce((stream, options) => ({
        kind: 'resource',
        stream,
        options,
        encoder: {
          setBitrate: () => {
            throw new Error('Encoder CTL error');
          },
        },
      }));

      void playPcm(player as unknown as AudioPlayer, Buffer.alloc(4));

      expect(player.play).toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'TTS encoder tuning skipped: Encoder CTL error'
      );
    });

    it('plays a resource without an encoder', () => {
      const player = new FakePlayer();
      expect(() =>
        playPcm(player as unknown as AudioPlayer, Buffer.alloc(4))
      ).not.toThrow();
      expect(player.play).toHaveBeenCalled();
    });
  });

  describe('a line arriving in parts', () => {
    it('plays every part, in order', async () => {
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES, 1);
        yield Buffer.alloc(FRAME_BYTES * 2, 2);
      }

      void playPcm(new FakePlayer() as unknown as AudioPlayer, parts());
      const chunks = await readAll(lastResource().stream);

      expect(Buffer.concat(chunks)).toEqual(
        Buffer.concat([
          Buffer.alloc(FRAME_BYTES, 1),
          Buffer.alloc(FRAME_BYTES * 2, 2),
        ])
      );
    });

    it('fills with silence once the audio sent has run out, until the late part arrives', async () => {
      const late = deferred<Buffer>();
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES * 5, 1); // 100 ms
        yield await late.promise;
      }

      void playPcm(new FakePlayer() as unknown as AudioPlayer, parts());
      const chunks = collect(lastResource().stream);
      await flush();
      expect(chunks).toHaveLength(5);

      // 61 ms of audio still to play: nothing is added yet.
      await vi.advanceTimersByTimeAsync(39);
      expect(chunks).toHaveLength(5);

      // Under 60 ms left: the player is kept fed with silence.
      await vi.advanceTimersByTimeAsync(1);
      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks[5].equals(Buffer.alloc(FRAME_BYTES))).toBe(true);

      late.resolve(Buffer.alloc(FRAME_BYTES, 2));
      await flush();
      expect(chunks.at(-1)?.equals(Buffer.alloc(FRAME_BYTES, 2))).toBe(true);
      expect(
        chunks.slice(5, -1).every((c) => c.equals(Buffer.alloc(FRAME_BYTES)))
      ).toBe(true);
    });

    it('adds no silence when the next part is ready in time', async () => {
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES * 5, 1);
        yield Buffer.alloc(FRAME_BYTES, 2);
      }

      void playPcm(new FakePlayer() as unknown as AudioPlayer, parts());
      const chunks = await collectAll(lastResource().stream);

      expect(chunks).toHaveLength(6);
      expect(chunks.some((c) => c.equals(Buffer.alloc(FRAME_BYTES)))).toBe(
        false
      );
    });

    it(`ends the line after ${MAX_FILL_MS / 1000}s of silence when the next part never comes`, async () => {
      const never = deferred<Buffer>();
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES * 5, 1); // 100 ms
        yield await never.promise;
      }

      void playPcm(new FakePlayer() as unknown as AudioPlayer, parts());
      const stream = lastResource().stream;
      const chunks = collect(stream);
      let ended = false;
      stream.once('end', () => {
        ended = true;
      });
      await flush();

      // Silence starts with 60 ms of audio left, 40 ms in.
      await vi.advanceTimersByTimeAsync(40 + MAX_FILL_MS - 100);
      expect(ended).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(ended).toBe(true);
      const silent = chunks.slice(5);
      expect(silent).toHaveLength(MAX_FILL_MS / 20);
      expect(silent.every((c) => c.equals(Buffer.alloc(FRAME_BYTES)))).toBe(
        true
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'TTS line cut short: its next part was over 3000 ms late'
      );
    });

    it('allows the full silence again after each part that arrives', async () => {
      const late = [deferred<Buffer>(), deferred<Buffer>()];
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES * 5, 1);
        yield await late[0].promise;
        yield await late[1].promise;
      }

      void playPcm(new FakePlayer() as unknown as AudioPlayer, parts());
      const stream = lastResource().stream;
      const chunks = collect(stream);
      let ended = false;
      stream.once('end', () => {
        ended = true;
      });
      await flush();

      // Two gaps, each shorter than the limit but longer together.
      await vi.advanceTimersByTimeAsync(MAX_FILL_MS - 500);
      late[0].resolve(Buffer.alloc(FRAME_BYTES, 2));
      await vi.advanceTimersByTimeAsync(MAX_FILL_MS - 500);
      late[1].resolve(Buffer.alloc(FRAME_BYTES, 3));
      await vi.advanceTimersByTimeAsync(100);

      expect(ended).toBe(true);
      expect(chunks.at(-1)?.equals(Buffer.alloc(FRAME_BYTES, 3))).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('gives up 5s after the audio sent so far, if the player never idles', async () => {
      const player = new FakePlayer();
      async function* parts() {
        yield Buffer.alloc(FRAME_BYTES * 50); // one second
      }
      let done = false;

      void playPcm(player as unknown as AudioPlayer, parts()).then(() => {
        done = true;
      });
      collect(lastResource().stream);
      await flush();

      await vi.advanceTimersByTimeAsync(5_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    });

    it('stops pulling parts once playback has ended', async () => {
      const player = new FakePlayer();
      let pulled = 0;
      let closed = false;
      async function* parts() {
        try {
          for (let i = 0; i < 100; i++) {
            pulled++;
            yield Buffer.alloc(FRAME_BYTES);
          }
        } finally {
          closed = true;
        }
      }

      const playing = playPcm(player as unknown as AudioPlayer, parts());
      // The encoder starts pulling, a few frames ahead of the player.
      lastResource().stream.read();
      await flush();
      expect(pulled).toBeGreaterThan(0);

      player.emit('idle');
      await playing;
      await flush();

      expect(lastResource().stream.destroyed).toBe(true);
      expect(closed).toBe(true);
      expect(pulled).toBeLessThan(100);
    });
  });
});

describe('ttsSessions (default wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    ttsSessions.stopAll();
  });

  function startDefault() {
    ttsSessions.start({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: 'u',
    });
  }

  it('mutes and unmutes through the connection manager', () => {
    startDefault();
    expect(connectionManager.setSelfMute).toHaveBeenCalledWith(VC, false);

    ttsSessions.stop(VC);
    expect(connectionManager.getPlayer).toHaveBeenCalledWith(VC);
    expect(connectionManager.setSelfMute).toHaveBeenCalledWith(VC, true);
  });

  it('fails synthesis when VOICEVOX is not configured', async () => {
    getVoicevoxClient.mockReturnValue(null);
    startDefault();

    ttsSessions.enqueue(VC, line('hello'));
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(
      'TTS synthesis failed: VOICEVOX_URL is not set'
    );
    expect(connectionManager.getPlayer).not.toHaveBeenCalled();
  });

  it('asks the configured engine for one query, renders its slices, and plays them on the connection’s player', async () => {
    const pcm = Buffer.from([9, 9, 9, 9]);
    const query = {
      accent_phrases: [
        { moras: [{}, {}, {}, {}], pause_mora: { vowel_length: 0.3 } },
        { moras: Array.from({ length: 8 }, () => ({})), pause_mora: null },
      ],
    };
    const client = {
      audioQuery: vi.fn().mockResolvedValue(query),
      renderQuery: vi.fn().mockResolvedValue(pcm),
    };
    getVoicevoxClient.mockReturnValue(client);
    const player = new FakePlayer();
    connectionManager.getPlayer.mockReturnValue(player);
    startDefault();

    ttsSessions.enqueue(VC, line('hello', { speakerId: 8, speed: 1.2 }));
    await flush();

    expect(client.audioQuery).toHaveBeenCalledWith('hello', 8);
    expect(client.renderQuery).toHaveBeenCalledTimes(2);
    const [first, second] = client.renderQuery.mock.calls;
    expect(first[0]).toMatchObject({
      accent_phrases: [query.accent_phrases[0]],
      prePhonemeLength: EDGE_SILENCE_SECONDS,
      postPhonemeLength: 0,
    });
    expect(first.slice(1)).toEqual([8, 1.2]);
    expect(second[0]).toMatchObject({
      accent_phrases: [query.accent_phrases[1]],
      prePhonemeLength: 0,
      postPhonemeLength: EDGE_SILENCE_SECONDS,
    });
    expect(player.play).toHaveBeenCalledTimes(1);

    player.emit('idle');
    await flush();
    expect(player.listenerCount('idle')).toBe(0);
  });

  it('renders an announced name on its own with a pause after it', async () => {
    const client = {
      audioQuery: vi.fn().mockResolvedValue({ accent_phrases: [] }),
      renderQuery: vi.fn().mockResolvedValue(Buffer.from([1, 1, 1, 1])),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([2, 2, 2, 2])),
    };
    getVoicevoxClient.mockReturnValue(client);
    connectionManager.getPlayer.mockReturnValue(new FakePlayer());
    startDefault();

    ttsSessions.enqueue(
      VC,
      line('hello', { authorName: 'たろう', speakerId: 8, speed: 1.2 })
    );
    await flush();

    expect(client.synthesize).toHaveBeenCalledWith('たろう', 8, 1.2, {
      postPhonemeLength: 0.25,
    });
  });

  it('warms voices up through the engine', async () => {
    const client = { initializeSpeaker: vi.fn().mockResolvedValue(true) };
    getVoicevoxClient.mockReturnValue(client);

    ttsSessions.warmUp([14]);
    await flush();

    expect(client.initializeSpeaker).toHaveBeenCalledWith(14);
  });

  it('skips warming up when VOICEVOX is not configured', async () => {
    getVoicevoxClient.mockReturnValue(null);

    expect(() => ttsSessions.warmUp([14])).not.toThrow();
    await flush();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
