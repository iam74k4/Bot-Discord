import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { VoiceConnectionState } from '../../../shared/types/voice.js';
import { logger } from '../../../shared/utils/logger.js';
import { channelMixRingManager } from '../recording/channelMixRing.js';
import {
  BEFORE_DISCONNECT_TIMEOUT_MS,
  connectionManager,
  getLiveDecoderCount,
  VoiceConnectionManager,
} from '../recording/connectionManager.js';

const joinVoiceChannel = vi.hoisted(() => vi.fn());
const entersState = vi.hoisted(() => vi.fn());
const createAudioPlayer = vi.hoisted(() => vi.fn(() => ({ kind: 'player' })));
const decoderOptions = vi.hoisted(() => [] as unknown[]);
const mockRing = vi.hoisted(() => ({
  /** Ring timeline in samples, with NOW as its epoch. */
  globalIndexAt: vi.fn(
    (ms: number) => (ms - new Date('2026-10-24T12:00:00.000Z').getTime()) * 48
  ),
  addMonoPcmInt16At: vi.fn(),
}));
const limitState = vi.hoisted(() => ({ max: 3, reads: 0 }));

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus: {
    Ready: 'ready',
    Disconnected: 'disconnected',
    Signalling: 'signalling',
    Connecting: 'connecting',
  },
  EndBehaviorType: { AfterSilence: 'after-silence' },
}));

vi.mock('prism-media', () => ({
  default: {
    opus: {
      Decoder: class {
        constructor(options: unknown) {
          decoderOptions.push(options);
        }
      },
    },
  },
}));

vi.mock('../../../config/index.js', () => ({
  env: {
    get MAX_CONCURRENT_VC_CONNECTIONS() {
      limitState.reads++;
      return limitState.max;
    },
  },
  AUDIO: { SAMPLE_RATE: 48000 },
}));

vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: {
    getOrCreate: vi.fn(() => mockRing),
    remove: vi.fn(),
    has: vi.fn(() => false),
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const NOW = new Date('2026-10-24T12:00:00.000Z').getTime();

/** Minimal Readable stand-in: emits events and records destroy(). */
class FakeStream extends EventEmitter {
  destroyed = false;
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    return this;
  });
}

/** Opus stream from receiver.subscribe(); pipe(decoder) yields the PCM stream. */
class FakeOpusStream extends FakeStream {
  readonly pcm = new FakeStream();
  readonly pipe = vi.fn(() => this.pcm);
}

type Handler = (...args: unknown[]) => unknown;

function makeConnection() {
  const handlers = new Map<string, Handler>();
  const speaking = new EventEmitter();
  const opusStreams: FakeOpusStream[] = [];
  const connection = {
    subscribe: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return connection;
    }),
    receiver: {
      speaking,
      subscribe: vi.fn(() => {
        const stream = new FakeOpusStream();
        opusStreams.push(stream);
        return stream;
      }),
    },
  };
  return {
    connection,
    opusStreams,
    /** Fire a connection event and wait for an async handler to settle. */
    fire: async (event: string, ...args: unknown[]) => {
      await handlers.get(event)?.(...args);
    },
    speak: (userId: string) => speaking.emit('start', userId),
  };
}

type FakeConnection = ReturnType<typeof makeConnection>;

interface ChannelOptions {
  me?: object | null;
  permissions?: { has: (flag: bigint) => boolean } | null;
}

function makeChannel(
  id: string,
  guildId = `guild-of-${id}`,
  opts: ChannelOptions = {}
) {
  const permissions =
    opts.permissions === undefined
      ? { has: (flag: bigint) => flag === PermissionFlagsBits.Connect }
      : opts.permissions;
  return {
    id,
    name: `channel-${id}`,
    guild: {
      id: guildId,
      name: `guild-${guildId}`,
      voiceAdapterCreator: vi.fn(),
      members: { me: opts.me === undefined ? { id: 'bot' } : opts.me },
    },
    permissionsFor: vi.fn(() => permissions),
  };
}

type FakeChannel = ReturnType<typeof makeChannel>;

function connectTo(manager: VoiceConnectionManager, channel: FakeChannel) {
  return manager.connect(channel.guild as never, channel as never);
}

/** Join a channel with a fresh fake connection and return its controls. */
async function join(
  manager: VoiceConnectionManager,
  channel: FakeChannel
): Promise<FakeConnection> {
  const fake = makeConnection();
  joinVoiceChannel.mockImplementationOnce(() => fake.connection);
  await expect(connectTo(manager, channel)).resolves.toBe(fake.connection);
  return fake;
}

function mono(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe('VoiceConnectionManager', () => {
  let manager: VoiceConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    decoderOptions.length = 0;
    limitState.max = 3;
    limitState.reads = 0;
    entersState.mockResolvedValue(undefined);
    manager = new VoiceConnectionManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports a shared singleton instance', () => {
    expect(connectionManager).toBeInstanceOf(VoiceConnectionManager);
  });

  describe('permissions', () => {
    it.each<[string, ChannelOptions]>([
      ['the bot member is not cached', { me: null }],
      ['permissions cannot be resolved', { permissions: null }],
      [
        'the Connect permission is missing',
        { permissions: { has: () => false } },
      ],
    ])('refuses to join when %s', async (_label, opts) => {
      const channel = makeChannel('ch-denied', 'guild-1', opts);

      await expect(connectTo(manager, channel)).resolves.toBeNull();

      expect(joinVoiceChannel).not.toHaveBeenCalled();
      expect(manager.getConnection('ch-denied')).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        'Bot does not have permission to connect to channel ch-denied'
      );
    });

    it('releases the slot and guild reservation after a permission refusal', async () => {
      limitState.max = 1;
      const denied = makeChannel('ch-denied', 'guild-1', { me: null });
      await expect(connectTo(manager, denied)).resolves.toBeNull();

      // Same guild, other channel: must not be blocked by the failed attempt.
      await join(manager, makeChannel('ch-allowed', 'guild-1'));

      expect(manager.getConnectionCount()).toBe(1);
    });
  });

  describe('connect', () => {
    it('joins unmuted-for-receive and self-muted with an audio player attached', async () => {
      const channel = makeChannel('ch-1', 'guild-1');

      const fake = await join(manager, channel);

      expect(joinVoiceChannel).toHaveBeenCalledWith({
        channelId: 'ch-1',
        guildId: 'guild-1',
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      const player = createAudioPlayer.mock.results[0]?.value as unknown;
      expect(fake.connection.subscribe).toHaveBeenCalledWith(player);
    });

    it('tracks the new connection as connecting', async () => {
      const fake = await join(manager, makeChannel('ch-1', 'guild-1'));

      expect(manager.getConnection('ch-1')).toEqual({
        connection: fake.connection,
        state: VoiceConnectionState.Connecting,
        channelId: 'ch-1',
        guildId: 'guild-1',
        connectedAt: NOW,
        lastActivity: NOW,
        receiving: true,
      });
      expect(manager.getConnectionCount()).toBe(1);
    });

    it('drops a mix ring left over from an earlier session but allocates none', async () => {
      await join(manager, makeChannel('ch-1'));

      expect(channelMixRingManager.remove).toHaveBeenCalledWith('ch-1');
      expect(channelMixRingManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('returns the existing connection instead of joining twice', async () => {
      const channel = makeChannel('ch-1');
      const fake = await join(manager, channel);

      await expect(connectTo(manager, channel)).resolves.toBe(fake.connection);

      expect(joinVoiceChannel).toHaveBeenCalledTimes(1);
    });

    it('returns null and frees the slot when joining throws', async () => {
      limitState.max = 1;
      joinVoiceChannel.mockImplementationOnce(() => {
        throw new Error('adapter unavailable');
      });
      const channel = makeChannel('ch-1');

      await expect(connectTo(manager, channel)).resolves.toBeNull();

      expect(manager.getConnection('ch-1')).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to connect to voice channel ch-1:',
        'adapter unavailable'
      );
      // A retry is not blocked by a leaked reservation.
      await join(manager, channel);
    });
  });

  describe('connection lifecycle events', () => {
    it('marks the connection connected and restamps connectedAt when ready', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      vi.setSystemTime(NOW + 5_000);

      await fake.fire('ready');

      expect(manager.getConnection('ch-1')).toMatchObject({
        state: VoiceConnectionState.Connected,
        connectedAt: NOW + 5_000,
      });
    });

    it('ignores a ready event from a connection that is no longer tracked', async () => {
      const channel = makeChannel('ch-1');
      const stale = await join(manager, channel);
      await manager.disconnect('ch-1');
      const current = await join(manager, channel);

      await stale.fire('ready');

      expect(manager.getConnection('ch-1')).toMatchObject({
        connection: current.connection,
        state: VoiceConnectionState.Connecting,
      });
    });

    it('ignores a ready event after the channel was left', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      await manager.disconnect('ch-1');

      await fake.fire('ready');

      expect(manager.getConnection('ch-1')).toBeUndefined();
    });

    it('logs state transitions', async () => {
      const fake = await join(manager, makeChannel('ch-1'));

      await fake.fire(
        'stateChange',
        { status: 'signalling' },
        { status: 'ready' }
      );

      expect(logger.debug).toHaveBeenCalledWith(
        'Voice connection state: signalling -> ready'
      );
    });

    it('keeps the connection when it recovers from a disconnect', async () => {
      const fake = await join(manager, makeChannel('ch-1'));

      await fake.fire('disconnected');

      expect(entersState).toHaveBeenCalledWith(
        fake.connection,
        'signalling',
        5_000
      );
      expect(entersState).toHaveBeenCalledWith(
        fake.connection,
        'connecting',
        5_000
      );
      expect(fake.connection.destroy).not.toHaveBeenCalled();
      expect(manager.getConnection('ch-1')).toBeDefined();
    });

    it('tears everything down when a disconnect does not recover', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      const [opus] = fake.opusStreams;
      vi.mocked(channelMixRingManager.remove).mockClear();
      entersState.mockRejectedValue(new Error('timed out'));

      await fake.fire('disconnected');

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getConnection('ch-1')).toBeUndefined();
      expect(channelMixRingManager.remove).toHaveBeenCalledWith('ch-1');
      expect(opus.destroy).toHaveBeenCalled();
      expect(opus.pcm.destroy).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'Disconnected from voice channel ch-1'
      );
    });

    it('frees a connection slot after an unrecovered disconnect', async () => {
      limitState.max = 1;
      const fake = await join(manager, makeChannel('ch-1'));
      entersState.mockRejectedValue(new Error('timed out'));

      await fake.fire('disconnected');

      expect(manager.isAtLimit()).toBe(false);
      await join(manager, makeChannel('ch-2'));
    });
  });

  describe('audio receive pipeline', () => {
    it('subscribes to a speaker until 1.5s of silence and decodes 48 kHz mono', async () => {
      const fake = await join(manager, makeChannel('ch-1'));

      fake.speak('user-1');

      expect(fake.connection.receiver.subscribe).toHaveBeenCalledWith(
        'user-1',
        { end: { behavior: 'after-silence', duration: 1500 } }
      );
      // Mono from the decoder: no JS downmix, and more decoders fit in the
      // opusscript heap than stereo ones would.
      expect(decoderOptions).toEqual([
        { rate: 48000, channels: 1, frameSize: 960 },
      ]);
    });

    it('feeds decoded mono PCM to the channel ring, ending at the receive time', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      vi.setSystemTime(NOW + 1_234);
      const pcm = mono([2000, -200, 32767, -32768, 0]);

      fake.opusStreams[0].pcm.emit('data', pcm);

      expect(channelMixRingManager.getOrCreate).toHaveBeenCalledWith('ch-1');
      expect(mockRing.addMonoPcmInt16At).toHaveBeenCalledTimes(1);
      const [chunk, start] = mockRing.addMonoPcmInt16At.mock.calls[0] as [
        Buffer,
        number,
      ];
      expect(chunk.equals(pcm)).toBe(true);
      expect(start).toBe(1_234 * 48 - 5);
    });

    it("lays a speaker's frames end to end however jittery their arrival", async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      const frame = Buffer.alloc(960 * 2);

      for (const [i, offset] of [0, 3, -4, 9, 1, -2, 12].entries()) {
        vi.setSystemTime(NOW + 1_000 + i * 20 + offset);
        fake.opusStreams[0].pcm.emit('data', frame);
      }

      const starts = mockRing.addMonoPcmInt16At.mock.calls.map(
        ([, start]) => start as number
      );
      expect(starts[0]).toBe(1_000 * 48 - 960);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBe(960);
      }
    });

    it('drops frames instead of writing them more than a second ahead of now', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      const frame = Buffer.alloc(960 * 2);
      vi.setSystemTime(NOW + 1_000);

      // 1.5 s of frames handled at one instant (a stall nobody paused in).
      for (let i = 0; i < 75; i++) {
        fake.opusStreams[0].pcm.emit('data', frame);
      }

      const starts = mockRing.addMonoPcmInt16At.mock.calls.map(
        ([, start]) => start as number
      );
      const now = 1_000 * 48;
      expect(starts.length).toBeLessThan(75);
      expect(Math.max(...starts) - now).toBeLessThanOrEqual(48_000);
    });

    it('gives each speaker their own placement', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      fake.speak('user-2');
      const frame = Buffer.alloc(960 * 2);
      vi.setSystemTime(NOW + 500);

      fake.opusStreams[0].pcm.emit('data', frame);
      fake.opusStreams[1].pcm.emit('data', frame);

      const starts = mockRing.addMonoPcmInt16At.mock.calls.map(
        ([, start]) => start as number
      );
      // Same instant, same slot: two people talking at once are mixed.
      expect(starts).toEqual([500 * 48 - 960, 500 * 48 - 960]);
    });

    it('counts live decoders and frees one when its stream ends, once', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      const before = getLiveDecoderCount();

      fake.speak('user-1');
      fake.speak('user-2');
      expect(getLiveDecoderCount()).toBe(before + 2);

      fake.opusStreams[0].pcm.emit('error', new Error('corrupt'));
      fake.opusStreams[0].pcm.emit('close');
      expect(getLiveDecoderCount()).toBe(before + 1);
    });

    it('warns, with the live decoder count, when the Opus heap is exhausted - at most once a minute', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      fake.speak('user-2');
      fake.speak('user-3');
      const exhausted = () =>
        new Error('RuntimeError: memory access out of bounds');

      vi.setSystemTime(NOW + 10 * 60_000);
      fake.opusStreams[0].pcm.emit('error', exhausted());
      fake.opusStreams[1].pcm.emit('error', exhausted());

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(
        /ran out of memory with \d+ live decoders/
      );

      vi.setSystemTime(NOW + 11 * 60_000);
      fake.opusStreams[2].pcm.emit('error', exhausted());
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('keeps ordinary decode errors at debug level', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');

      fake.opusStreams[0].pcm.emit('error', new Error('corrupted packet'));

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Audio decode error for user user-1:',
        'corrupted packet'
      );
    });

    it('subscribes once per speaker while their stream is open', async () => {
      const fake = await join(manager, makeChannel('ch-1'));

      fake.speak('user-1');
      fake.speak('user-1');
      fake.speak('user-2');

      expect(fake.connection.receiver.subscribe).toHaveBeenCalledTimes(2);
      expect(fake.opusStreams).toHaveLength(2);
    });

    it.each([
      ['the PCM stream closes', (s: FakeOpusStream) => s.pcm.emit('close')],
      [
        'the decoder errors',
        (s: FakeOpusStream) => s.pcm.emit('error', new Error('corrupt')),
      ],
      [
        'the opus stream errors',
        (s: FakeOpusStream) => s.emit('error', new Error('reset')),
      ],
    ])(
      'cleans up and resubscribes the speaker after %s',
      async (_label, endStream) => {
        const fake = await join(manager, makeChannel('ch-1'));
        fake.speak('user-1');
        const [first] = fake.opusStreams;

        endStream(first);

        expect(first.destroy).toHaveBeenCalledTimes(1);
        expect(first.pcm.destroy).toHaveBeenCalledTimes(1);

        fake.speak('user-1');
        expect(fake.connection.receiver.subscribe).toHaveBeenCalledTimes(2);
      }
    );

    it('does not destroy streams that are already destroyed', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      const [stream] = fake.opusStreams;
      stream.destroyed = true;
      stream.pcm.destroyed = true;

      stream.pcm.emit('close');

      expect(stream.destroy).not.toHaveBeenCalled();
      expect(stream.pcm.destroy).not.toHaveBeenCalled();
    });

    it('drops audio that arrives after the channel was left', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      const [stream] = fake.opusStreams;
      await manager.disconnect('ch-1');

      stream.pcm.emit('data', mono([1000]));

      expect(channelMixRingManager.getOrCreate).not.toHaveBeenCalled();
      expect(mockRing.addMonoPcmInt16At).not.toHaveBeenCalled();
    });

    it('keeps audio from different channels in separate rings', async () => {
      const a = await join(manager, makeChannel('ch-a', 'guild-a'));
      const b = await join(manager, makeChannel('ch-b', 'guild-b'));
      a.speak('user-1');
      b.speak('user-1');

      a.opusStreams[0].pcm.emit('data', mono([10]));
      b.opusStreams[0].pcm.emit('data', mono([20]));

      expect(vi.mocked(channelMixRingManager.getOrCreate).mock.calls).toEqual([
        ['ch-a'],
        ['ch-b'],
      ]);
    });
  });

  describe('disconnect', () => {
    it('is a no-op for a channel that is not connected', async () => {
      await expect(manager.disconnect('unknown')).resolves.toBeUndefined();

      expect(channelMixRingManager.remove).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('destroys the connection, its open audio streams and its ring', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      fake.speak('user-2');
      vi.mocked(channelMixRingManager.remove).mockClear();

      await manager.disconnect('ch-1');

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
      for (const stream of fake.opusStreams) {
        expect(stream.destroy).toHaveBeenCalled();
        expect(stream.pcm.destroy).toHaveBeenCalled();
      }
      expect(channelMixRingManager.remove).toHaveBeenCalledWith('ch-1');
      expect(manager.getConnection('ch-1')).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(
        'Disconnected from voice channel ch-1'
      );
    });

    it('finishes even if destroying one audio stream throws', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.speak('user-1');
      fake.speak('user-2');
      fake.opusStreams[0].destroy.mockImplementation(() => {
        throw new Error('already gone');
      });

      await manager.disconnect('ch-1');

      expect(fake.opusStreams[1].destroy).toHaveBeenCalled();
      expect(fake.connection.destroy).toHaveBeenCalled();
      expect(manager.getConnection('ch-1')).toBeUndefined();
    });

    it('still forgets the channel when destroying the connection throws', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      fake.connection.destroy.mockImplementation(() => {
        throw new Error('already destroyed');
      });
      vi.mocked(channelMixRingManager.remove).mockClear();

      await expect(manager.disconnect('ch-1')).resolves.toBeUndefined();

      expect(manager.getConnection('ch-1')).toBeUndefined();
      expect(channelMixRingManager.remove).toHaveBeenCalledWith('ch-1');
      expect(logger.error).toHaveBeenCalledWith(
        'Error disconnecting from channel ch-1:',
        'already destroyed'
      );
    });

    it('lets the same guild join another channel afterwards', async () => {
      await join(manager, makeChannel('ch-a', 'guild-1'));
      await manager.disconnect('ch-a');

      await join(manager, makeChannel('ch-b', 'guild-1'));

      expect(manager.getConnection('ch-b')).toBeDefined();
    });
  });

  describe('before-disconnect hooks', () => {
    it('runs the hook while the connection is still up, and leaves once it is done', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      let release!: () => void;
      const seen: boolean[] = [];
      manager.onBeforeDisconnect((channelId) => {
        seen.push(manager.getConnection(channelId) !== undefined);
        return new Promise<void>((resolve) => (release = resolve));
      });

      const leaving = manager.disconnect('ch-1');
      await Promise.resolve();

      expect(seen).toEqual([true]);
      expect(fake.connection.destroy).not.toHaveBeenCalled();
      release();
      await leaving;
      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getConnection('ch-1')).toBeUndefined();
    });

    it('stays synchronous when no hook has anything to do', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      manager.onBeforeDisconnect(() => undefined);

      void manager.disconnect('ch-1');

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
    });

    it('leaves after the timeout when a hook hangs', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const fake = await join(manager, makeChannel('ch-1'));
      manager.onBeforeDisconnect(() => new Promise<void>(() => undefined));

      const leaving = manager.disconnect('ch-1');
      await vi.advanceTimersByTimeAsync(BEFORE_DISCONNECT_TIMEOUT_MS - 1);
      expect(fake.connection.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await leaving;

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
    });

    it('leaves even when a hook throws or rejects', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      manager.onBeforeDisconnect(() => {
        throw new Error('sync');
      });
      manager.onBeforeDisconnect(() => Promise.reject(new Error('async')));

      await manager.disconnect('ch-1');

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
      expect(manager.getConnection('ch-1')).toBeUndefined();
    });

    it('tears down once when two disconnects overlap the hook', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      const listener = vi.fn();
      manager.onDisconnect(listener);
      manager.onBeforeDisconnect(() => Promise.resolve());

      await Promise.all([
        manager.disconnect('ch-1'),
        manager.disconnect('ch-1'),
      ]);

      expect(fake.connection.destroy).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops running a hook once it is unsubscribed', async () => {
      await join(manager, makeChannel('ch-1'));
      const hook = vi.fn(() => undefined);
      const unsubscribe = manager.onBeforeDisconnect(hook);
      unsubscribe();

      await manager.disconnect('ch-1');

      expect(hook).not.toHaveBeenCalled();
    });

    it('is not run when Discord already dropped the connection', async () => {
      const fake = await join(manager, makeChannel('ch-1'));
      const hook = vi.fn(() => undefined);
      manager.onBeforeDisconnect(hook);
      entersState.mockRejectedValue(new Error('timeout'));

      await fake.fire('disconnected');

      expect(manager.getConnection('ch-1')).toBeUndefined();
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('connection limit', () => {
    it('does not read the limit from config until it is needed', () => {
      new VoiceConnectionManager();

      expect(limitState.reads).toBe(0);
    });

    it('reports the limit once MAX_CONCURRENT_VC_CONNECTIONS channels are joined', async () => {
      limitState.max = 2;

      await join(manager, makeChannel('ch-1'));
      expect(manager.isAtLimit()).toBe(false);

      await join(manager, makeChannel('ch-2'));
      expect(manager.isAtLimit()).toBe(true);
    });

    it('refuses a join over the limit and logs why', async () => {
      limitState.max = 2;
      await join(manager, makeChannel('ch-1'));
      await join(manager, makeChannel('ch-2'));

      await expect(connectTo(manager, makeChannel('ch-3'))).resolves.toBeNull();

      expect(joinVoiceChannel).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'Connection limit reached (2). Cannot connect to channel ch-3'
      );
    });

    it('admits a new join once a slot is freed', async () => {
      limitState.max = 1;
      await join(manager, makeChannel('ch-1'));
      await expect(connectTo(manager, makeChannel('ch-2'))).resolves.toBeNull();

      await manager.disconnect('ch-1');

      await join(manager, makeChannel('ch-2'));
    });

    it('caches the limit after first use', async () => {
      limitState.max = 1;
      await join(manager, makeChannel('ch-1'));

      limitState.max = 5;

      expect(manager.isAtLimit()).toBe(true);
    });
  });

  describe('bookkeeping', () => {
    it('names the channel the bot is in for a guild, and nothing for other guilds', async () => {
      await join(manager, makeChannel('ch-a', 'guild-a'));
      await join(manager, makeChannel('ch-b', 'guild-b'));

      expect(manager.getConnectedChannelInGuild('guild-a')).toBe('ch-a');
      expect(manager.getConnectedChannelInGuild('guild-b')).toBe('ch-b');
      expect(manager.getConnectedChannelInGuild('guild-c')).toBeUndefined();

      await manager.disconnect('ch-a');
      expect(manager.getConnectedChannelInGuild('guild-a')).toBeUndefined();
    });

    it('returns undefined for an unknown channel', () => {
      expect(manager.getConnection('nope')).toBeUndefined();
      expect(manager.getConnectionCount()).toBe(0);
    });

    it('returns a copy of all connections that callers cannot mutate', async () => {
      await join(manager, makeChannel('ch-1'));

      const all = manager.getAllConnections();
      all.delete('ch-1');

      expect([...all.keys()]).toEqual([]);
      expect(manager.getConnectionCount()).toBe(1);
      expect([...manager.getAllConnections().keys()]).toEqual(['ch-1']);
    });

    it('updates lastActivity for a tracked channel only', async () => {
      await join(manager, makeChannel('ch-1'));
      vi.setSystemTime(NOW + 60_000);

      manager.updateActivity('ch-1');
      manager.updateActivity('unknown');

      expect(manager.getConnection('ch-1')?.lastActivity).toBe(NOW + 60_000);
      expect(manager.getConnection('unknown')).toBeUndefined();
    });

    it('disconnectOldest drops the longest-connected channels first', async () => {
      vi.setSystemTime(NOW + 2_000);
      await join(manager, makeChannel('ch-middle'));
      vi.setSystemTime(NOW + 1_000);
      await join(manager, makeChannel('ch-oldest'));
      vi.setSystemTime(NOW + 3_000);
      await join(manager, makeChannel('ch-newest'));

      await manager.disconnectOldest(2);

      expect([...manager.getAllConnections().keys()]).toEqual(['ch-newest']);
    });

    it('disconnectOldest handles counts larger than the connection list or zero', async () => {
      await join(manager, makeChannel('ch-1'));
      await join(manager, makeChannel('ch-2'));

      await manager.disconnectOldest(0);
      expect(manager.getConnectionCount()).toBe(2);

      await manager.disconnectOldest(10);
      expect(manager.getConnectionCount()).toBe(0);
    });
  });
});
