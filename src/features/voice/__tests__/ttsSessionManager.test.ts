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

const { MAX_QUEUE_LENGTH, playPcm, TtsSessionManager, ttsSessions } =
  await import('../tts/sessionManager.js');
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

/** Let every pending promise chain settle; no timers involved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
}

const GUILD = 'guild-1';
const VC = 'vc-1';
const TEXT = 'text-1';

/**
 * Deps whose synthesis and playback complete only when a test says so
 * (`auto: false`) or immediately (`auto: true`). Synthesized audio is the
 * spoken text itself, so `played()` reads back what was said, in order.
 */
function harness({ auto = false } = {}) {
  const player = { stop: vi.fn() } as unknown as AudioPlayer & {
    stop: ReturnType<typeof vi.fn>;
  };
  const synths: Array<{
    text: string;
    speakerId: number;
    speed: number;
    job: Deferred<Buffer>;
  }> = [];
  const plays: Array<{ text: string; job: Deferred<void> }> = [];
  const state = {
    auto,
    now: 0,
    player: player as AudioPlayer | undefined,
    failText: null as string | null,
  };

  const deps = {
    getPlayer: vi.fn(() => state.player),
    setSelfMute: vi.fn(() => true),
    synthesize: vi.fn((text: string, speakerId: number, speed: number) => {
      const job = deferred<Buffer>();
      synths.push({ text, speakerId, speed, job });
      if (state.failText !== null && text.includes(state.failText)) {
        job.reject(new Error(`engine choked on ${text}`));
      } else if (state.auto) {
        job.resolve(Buffer.from(text));
      }
      return job.promise;
    }),
    play: vi.fn((_player: AudioPlayer, pcm: Buffer) => {
      const job = deferred<void>();
      plays.push({ text: pcm.toString(), job });
      if (state.auto) job.resolve();
      return job.promise;
    }),
  };

  const manager = new TtsSessionManager(deps, () => state.now);

  return {
    deps,
    manager,
    player,
    state,
    synths,
    plays,
    synthesized: () => synths.map((s) => s.text),
    played: () => plays.map((p) => p.text),
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
      expect(h.deps.synthesize).not.toHaveBeenCalled();
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
        h.synths.map(({ text, speakerId, speed }) => [text, speakerId, speed])
      ).toEqual([
        ['one', 1, 0.8],
        ['two', 2, 1.5],
        ['three', 3, 1],
      ]);
      expect(h.deps.play).toHaveBeenCalledWith(h.player, expect.any(Buffer));
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
      });
    });

    it(`caps the queue at ${MAX_QUEUE_LENGTH}, dropping the oldest waiting line`, async () => {
      const h = harness();
      h.start();

      h.manager.enqueue(VC, line('L1')); // taken off the queue immediately
      for (let i = 2; i <= MAX_QUEUE_LENGTH + 2; i++) {
        h.manager.enqueue(VC, line(`L${i}`));
      }
      expect(h.manager.queueLength(VC)).toBe(MAX_QUEUE_LENGTH);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('dropped oldest line')
      );

      // Let everything through.
      h.state.auto = true;
      for (const s of h.synths) s.job.resolve(Buffer.from(s.text));
      await flush();

      const expected = ['L1'];
      for (let i = 3; i <= MAX_QUEUE_LENGTH + 2; i++) expected.push(`L${i}`);
      expect(h.played()).toEqual(expected);
      expect(h.played()).not.toContain('L2');
    });

    it('synthesizes at most two lines ahead of the one being played', async () => {
      const h = harness();
      h.start();

      h.manager.enqueue(VC, line('L1'));
      h.manager.enqueue(VC, line('L2'));
      h.manager.enqueue(VC, line('L3'));
      h.manager.enqueue(VC, line('L4'));
      h.manager.enqueue(VC, line('L5'));
      await flush();
      expect(h.synthesized()).toEqual(['L1', 'L2', 'L3']);

      // L1 is rendered and starts playing; the lookahead stays at two.
      h.synths[0].job.resolve(Buffer.from('L1'));
      await flush();
      expect(h.played()).toEqual(['L1']);
      expect(h.synthesized()).toEqual(['L1', 'L2', 'L3']);

      // L1 ends; L2 plays and L4 starts rendering.
      h.synths[1].job.resolve(Buffer.from('L2'));
      h.plays[0].job.resolve();
      await flush();
      expect(h.played()).toEqual(['L1', 'L2']);
      expect(h.synthesized()).toEqual(['L1', 'L2', 'L3', 'L4']);
    });

    it('skips a line whose synthesis fails and carries on', async () => {
      const h = harness({ auto: true });
      h.state.failText = 'bad';
      h.start();

      h.manager.enqueue(VC, line('good 1'));
      h.manager.enqueue(VC, line('bad'));
      h.manager.enqueue(VC, line('good 2'));
      await flush();

      expect(h.played()).toEqual(['good 1', 'good 2']);
      expect(logger.warn).toHaveBeenCalledWith(
        'TTS synthesis failed: engine choked on bad'
      );
    });

    it('keeps playing the rest of the queue when one clip fails to play', async () => {
      const h = harness({ auto: true });
      h.deps.play.mockImplementationOnce(() => {
        throw new Error('player.play threw');
      });
      h.start();

      h.manager.enqueue(VC, line('one'));
      h.manager.enqueue(VC, line('two'));
      h.manager.enqueue(VC, line('three'));
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

      h.manager.enqueue(VC, line('silent'));
      h.manager.enqueue(VC, line('loud'));
      h.synths[0].job.resolve(Buffer.alloc(0));
      h.synths[1].job.resolve(Buffer.from('loud'));
      await flush();

      expect(h.played()).toEqual(['loud']);
    });

    it('ends the session when the connection has no player', async () => {
      const h = harness({ auto: true });
      h.start();
      h.state.player = undefined;
      h.deps.setSelfMute.mockClear();

      h.manager.enqueue(VC, line('hello'));
      h.manager.enqueue(VC, line('again'));
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
      h.manager.enqueue(VC, line('long'));
      h.manager.enqueue(VC, line('next'));
      h.synths[0].job.resolve(Buffer.from('long'));
      h.synths[1].job.resolve(Buffer.from('next'));
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

    it('never plays a line skipped while it is still being synthesized', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, line('skipped'));
      h.manager.enqueue(VC, line('kept'));
      await flush();

      expect(h.manager.skip(VC)).toBe(true);

      h.synths[0].job.resolve(Buffer.from('skipped'));
      await flush();
      expect(h.deps.play).not.toHaveBeenCalled();

      h.synths[1].job.resolve(Buffer.from('kept'));
      await flush();
      expect(h.played()).toEqual(['kept']);
    });
  });

  describe('stopping mid-queue', () => {
    it('plays nothing more after stop, even when the current clip ends', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, line('L1'));
      h.manager.enqueue(VC, line('L2'));
      h.manager.enqueue(VC, line('L3'));
      for (const s of h.synths) s.job.resolve(Buffer.from(s.text));
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

    it('does not play a line whose synthesis finishes after stop', async () => {
      const h = harness();
      h.start();
      h.manager.enqueue(VC, line('L1'));
      await flush();

      h.manager.stop(VC);
      h.synths[0].job.resolve(Buffer.from('L1'));
      await flush();

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

      h.synths[0].job.resolve(Buffer.from('old'));
      h.synths[1].job.resolve(Buffer.from('new'));
      await flush();

      expect(h.played()).toEqual(['new']);
    });
  });
});

/** A player that behaves like @discordjs/voice's for listener bookkeeping. */
class FakePlayer extends EventEmitter {
  readonly play = vi.fn();
  readonly stop = vi.fn();
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('playPcm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays the PCM as a raw resource and resolves when the player goes idle', async () => {
    const player = new FakePlayer();
    const pcm = Buffer.from([1, 2, 3, 4]);
    let done = false;

    const playing = playPcm(player as unknown as AudioPlayer, pcm).then(() => {
      done = true;
    });

    expect(createAudioResource).toHaveBeenCalledWith(expect.any(Readable), {
      inputType: 'raw',
    });
    const resource = createAudioResource.mock.results[0].value;
    expect(player.play).toHaveBeenCalledWith(resource);
    expect(await readAll(resource.stream as Readable)).toEqual(pcm);

    await flush();
    expect(done).toBe(false);

    player.emit('idle');
    await playing;
    expect(done).toBe(true);
    expect(player.listenerCount('idle')).toBe(0);
    expect(player.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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
  });
});

describe('ttsSessions (default wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    ttsSessions.stopAll();
  });

  it('mutes and unmutes through the connection manager', () => {
    ttsSessions.start({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: 'u',
    });
    expect(connectionManager.setSelfMute).toHaveBeenCalledWith(VC, false);

    ttsSessions.stop(VC);
    expect(connectionManager.getPlayer).toHaveBeenCalledWith(VC);
    expect(connectionManager.setSelfMute).toHaveBeenCalledWith(VC, true);
  });

  it('fails synthesis when VOICEVOX is not configured', async () => {
    getVoicevoxClient.mockReturnValue(null);
    ttsSessions.start({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: 'u',
    });

    ttsSessions.enqueue(VC, line('hello'));
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(
      'TTS synthesis failed: VOICEVOX_URL is not set'
    );
    expect(connectionManager.getPlayer).not.toHaveBeenCalled();
  });

  it('synthesizes with the configured client and plays on the connection’s player', async () => {
    const pcm = Buffer.from([9, 9, 9, 9]);
    const synthesize = vi.fn().mockResolvedValue(pcm);
    getVoicevoxClient.mockReturnValue({ synthesize });
    const player = new FakePlayer();
    connectionManager.getPlayer.mockReturnValue(player);
    ttsSessions.start({
      guildId: GUILD,
      voiceChannelId: VC,
      textChannelId: TEXT,
      startedBy: 'u',
    });

    ttsSessions.enqueue(VC, line('hello', { speakerId: 8, speed: 1.2 }));
    await flush();

    expect(synthesize).toHaveBeenCalledWith('hello', 8, 1.2);
    expect(player.play).toHaveBeenCalledTimes(1);
    player.emit('idle');
    await flush();
    expect(player.listenerCount('idle')).toBe(0);
  });
});
