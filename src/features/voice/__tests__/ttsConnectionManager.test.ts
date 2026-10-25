import { EventEmitter } from 'events';
import { PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The parts of the connection manager text-to-speech relies on: one audio
 * player per connection, toggling self-mute in place, waiting for a join to
 * land, disconnect notifications, and joining deafened without receiving.
 */
const joinVoiceChannel = vi.hoisted(() => vi.fn());
const entersState = vi.hoisted(() => vi.fn());
const createAudioPlayer = vi.hoisted(() => vi.fn());

vi.mock('@discordjs/voice', () => ({
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  VoiceConnectionStatus: {
    Ready: 'ready',
    Disconnected: 'disconnected',
    Signalling: 'signalling',
    Connecting: 'connecting',
    Destroyed: 'destroyed',
  },
  EndBehaviorType: { AfterSilence: 'after-silence' },
}));

vi.mock('prism-media', () => ({
  default: {
    opus: {
      Decoder: class {},
    },
  },
}));

vi.mock('../../../config/index.js', () => ({
  env: { MAX_CONCURRENT_VC_CONNECTIONS: 5 },
  AUDIO: { SAMPLE_RATE: 48000 },
}));

/** Channels whose mix ring exists, i.e. that have buffered audio. */
const ringHolders = vi.hoisted(() => new Set<string>());

vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: {
    getOrCreate: vi.fn(() => ({ addMonoPcmInt16: vi.fn() })),
    remove: vi.fn(),
    has: vi.fn((channelId: string) => ringHolders.has(channelId)),
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { VoiceConnectionManager } =
  await import('../recording/connectionManager.js');
const { logger } = await import('../../../shared/utils/logger.js');

type Handler = (...args: unknown[]) => unknown;
type Manager = InstanceType<typeof VoiceConnectionManager>;

/** Opus stream stand-in; pipe(decoder) yields a PCM stream. */
class FakeStream extends EventEmitter {
  destroyed = false;
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  pipe = vi.fn(() => new FakeStream());
}

function makeConnection(selfDeaf: boolean, status = 'ready') {
  const handlers = new Map<string, Handler>();
  const onceHandlers = new Map<string, Handler>();
  const connection = {
    joinConfig: { selfDeaf, selfMute: true },
    state: { status },
    subscribe: vi.fn(),
    destroy: vi.fn(),
    rejoin: vi.fn(() => true),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return connection;
    }),
    once: vi.fn((event: string, handler: Handler) => {
      onceHandlers.set(event, handler);
      return connection;
    }),
    receiver: {
      speaking: new EventEmitter(),
      subscribe: vi.fn(() => new FakeStream()),
    },
  };
  return {
    connection,
    fire: async (event: string) => {
      await handlers.get(event)?.();
    },
    fireOnce: (event: string) => {
      const handler = onceHandlers.get(event);
      onceHandlers.delete(event);
      return handler?.();
    },
  };
}

function makeChannel(id = 'vc-1', guildId = 'guild-1') {
  return {
    id,
    name: `channel-${id}`,
    guild: {
      id: guildId,
      name: `guild-${guildId}`,
      voiceAdapterCreator: vi.fn(),
      members: { me: { id: 'bot' } },
    },
    permissionsFor: vi.fn(() => ({
      has: (flag: bigint) => flag === PermissionFlagsBits.Connect,
    })),
  };
}

function makePlayer() {
  return { stop: vi.fn() };
}

/** Join with a fresh fake connection; `selfDeaf` follows the join options. */
async function join(
  manager: Manager,
  options?: { receive?: boolean },
  { id = 'vc-1', status = 'ready', guildId = 'guild-1' } = {}
) {
  const channel = makeChannel(id, guildId);
  const player = makePlayer();
  createAudioPlayer.mockReturnValueOnce(player);
  let fake!: ReturnType<typeof makeConnection>;
  joinVoiceChannel.mockImplementationOnce((config: { selfDeaf: boolean }) => {
    fake = makeConnection(config.selfDeaf, status);
    return fake.connection;
  });
  const result = await manager.connect(
    channel.guild as never,
    channel as never,
    options
  );
  expect(result).toBe(fake.connection);
  return { ...fake, channel, player };
}

describe('VoiceConnectionManager (text-to-speech support)', () => {
  let manager: Manager;

  beforeEach(() => {
    vi.clearAllMocks();
    ringHolders.clear();
    entersState.mockResolvedValue(undefined);
    manager = new VoiceConnectionManager();
  });

  describe('receive option', () => {
    it.each([
      ['by default', undefined],
      ['with receive: true', { receive: true }],
    ])('listens and records %s', async (_label, options) => {
      const { connection } = await join(manager, options);

      expect(joinVoiceChannel).toHaveBeenCalledWith(
        expect.objectContaining({ selfDeaf: false, selfMute: true })
      );
      expect(manager.getConnection('vc-1')?.receiving).toBe(true);

      connection.receiver.speaking.emit('start', 'user-1');
      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        'user-1',
        expect.anything()
      );
    });

    it('joins deafened and never subscribes to audio with receive: false', async () => {
      const { connection } = await join(manager, { receive: false });

      expect(joinVoiceChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: 'vc-1',
          guildId: 'guild-1',
          selfDeaf: true,
          selfMute: true,
        })
      );
      expect(manager.getConnection('vc-1')?.receiving).toBe(false);

      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-2');
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
    });

    it('still gives a non-receiving connection an audio player', async () => {
      const { connection, player } = await join(manager, { receive: false });
      expect(connection.subscribe).toHaveBeenCalledWith(player);
      expect(manager.getPlayer('vc-1')).toBe(player);
    });
  });

  describe('getPlayer', () => {
    it('is undefined for a channel that is not connected', () => {
      expect(manager.getPlayer('vc-1')).toBeUndefined();
    });

    it('returns the player subscribed to the connection', async () => {
      const { connection, player } = await join(manager);
      expect(connection.subscribe).toHaveBeenCalledWith(player);
      expect(manager.getPlayer('vc-1')).toBe(player);
    });

    it('stops and forgets the player on disconnect', async () => {
      const { player } = await join(manager);

      await manager.disconnect('vc-1');

      expect(player.stop).toHaveBeenCalledWith(true);
      expect(manager.getPlayer('vc-1')).toBeUndefined();
    });

    it('tolerates a player that throws when stopped', async () => {
      const { player } = await join(manager);
      player.stop.mockImplementation(() => {
        throw new Error('already stopped');
      });

      await expect(manager.disconnect('vc-1')).resolves.toBeUndefined();
      expect(manager.getPlayer('vc-1')).toBeUndefined();
      expect(manager.getConnection('vc-1')).toBeUndefined();
    });
  });

  describe('setSelfMute', () => {
    it('is false for a channel that is not connected', () => {
      expect(manager.setSelfMute('vc-1', false)).toBe(false);
    });

    it('rejoins at once on a ready connection, keeping selfDeaf', async () => {
      const { connection } = await join(manager, { receive: false });

      expect(manager.setSelfMute('vc-1', false)).toBe(true);

      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: true,
        selfMute: false,
      });
      expect(connection.once).not.toHaveBeenCalled();
    });

    it('keeps a listening connection undeafened when muting again', async () => {
      const { connection } = await join(manager);

      manager.setSelfMute('vc-1', true);

      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: false,
        selfMute: true,
      });
    });

    it('returns what rejoin reports', async () => {
      const { connection } = await join(manager);
      connection.rejoin.mockReturnValue(false);
      expect(manager.setSelfMute('vc-1', false)).toBe(false);
    });

    it('waits for a connection that is still handshaking', async () => {
      const { connection, fireOnce } = await join(manager, undefined, {
        status: 'signalling',
      });

      expect(manager.setSelfMute('vc-1', false)).toBe(true);
      expect(connection.rejoin).not.toHaveBeenCalled();
      expect(connection.once).toHaveBeenCalledWith(
        'ready',
        expect.any(Function)
      );

      fireOnce('ready');
      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: false,
        selfMute: false,
      });
    });

    it('keeps the deafen state from whether it receives, not from joinConfig', async () => {
      const { connection, fireOnce } = await join(manager, undefined, {
        status: 'connecting',
      });
      manager.setSelfMute('vc-1', true);

      // A late voice-state update from an older deafened state rewrote it.
      connection.joinConfig.selfDeaf = true;
      fireOnce('ready');

      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: false,
        selfMute: true,
      });
    });

    it('stays deafened for a reading-only connection', async () => {
      const { connection } = await join(manager, { receive: false });
      connection.joinConfig.selfDeaf = false;

      manager.setSelfMute('vc-1', false);

      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: true,
        selfMute: false,
      });
    });
  });

  describe('waitUntilReady', () => {
    /** Statuses each connection has reached, and waiters per status. */
    function controllableStates() {
      const waiters: Array<{
        connection: unknown;
        status: string;
        resolve: () => void;
      }> = [];
      entersState.mockImplementation(
        (connection: unknown, status: string, signal: AbortSignal) =>
          new Promise<unknown>((resolve, reject) => {
            waiters.push({
              connection,
              status,
              resolve: () => resolve(connection),
            });
            signal.addEventListener('abort', () =>
              reject(new Error('The operation was aborted'))
            );
          })
      );
      return {
        reach(connection: unknown, status: string) {
          for (const w of waiters) {
            if (w.connection === connection && w.status === status) {
              w.resolve();
            }
          }
        },
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is null for a channel that is not connected', async () => {
      await expect(manager.waitUntilReady('vc-1', 1000)).resolves.toBeNull();
      expect(entersState).not.toHaveBeenCalled();
    });

    it('returns the connection once it reaches Ready', async () => {
      const states = controllableStates();
      const { connection } = await join(manager);

      const waiting = manager.waitUntilReady('vc-1', 15_000);
      states.reach(connection, 'ready');

      await expect(waiting).resolves.toBe(connection);
      expect(entersState).toHaveBeenCalledWith(
        connection,
        'ready',
        expect.any(AbortSignal)
      );
      // Nothing is left listening once the wait is over.
      for (const [, , signal] of entersState.mock.calls) {
        expect((signal as AbortSignal).aborted).toBe(true);
      }
    });

    it('is null when the connection does not become ready in time', async () => {
      vi.useFakeTimers();
      controllableStates();
      await join(manager);

      let result: unknown = 'pending';
      void manager.waitUntilReady('vc-1', 15_000).then((r) => {
        result = r;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);

      expect(result).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('gives up at once when the connection is destroyed while waiting', async () => {
      vi.useFakeTimers();
      const states = controllableStates();
      const { connection } = await join(manager);

      const waiting = manager.waitUntilReady('vc-1', 15_000);
      states.reach(connection, 'destroyed');

      // No need to run out the 15 s: a destroyed connection never readies.
      await expect(waiting).resolves.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is null when the channel got a different connection meanwhile', async () => {
      const states = controllableStates();
      const first = await join(manager);
      const waiting = manager.waitUntilReady('vc-1', 15_000);

      // The first connection goes away and a fresh join replaces it.
      await manager.disconnect('vc-1');
      const second = await join(manager);
      states.reach(first.connection, 'ready');

      await expect(waiting).resolves.toBeNull();
      expect(manager.getConnection('vc-1')?.connection).toBe(second.connection);
    });
  });

  describe('disconnect with an expected connection', () => {
    it('leaves a replacement connection alone', async () => {
      const first = await join(manager);
      await manager.disconnect('vc-1');
      const second = await join(manager);

      await manager.disconnect('vc-1', first.connection as never);

      expect(second.connection.destroy).not.toHaveBeenCalled();
      expect(manager.getConnection('vc-1')?.connection).toBe(second.connection);
    });

    it('disconnects when it is still the connection tracked there', async () => {
      const { connection } = await join(manager);

      await manager.disconnect('vc-1', connection as never);

      expect(connection.destroy).toHaveBeenCalled();
      expect(manager.getConnection('vc-1')).toBeUndefined();
    });
  });

  describe('enableReceive', () => {
    it('is false for a channel that is not connected', () => {
      expect(manager.enableReceive('vc-1')).toBe(false);
    });

    it('is false for a connection that already listens', async () => {
      const { connection } = await join(manager);

      expect(manager.enableReceive('vc-1')).toBe(false);
      expect(connection.rejoin).not.toHaveBeenCalled();
    });

    it('undeafens a reading-only join in place and starts receiving', async () => {
      const { connection } = await join(manager, { receive: false });
      connection.receiver.speaking.emit('start', 'user-1');
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();

      expect(manager.enableReceive('vc-1')).toBe(true);

      expect(manager.getConnection('vc-1')?.receiving).toBe(true);
      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: false,
        selfMute: true,
      });
      expect(connection.destroy).not.toHaveBeenCalled();
      connection.receiver.speaking.emit('start', 'user-1');
      expect(connection.receiver.subscribe).toHaveBeenCalledWith(
        'user-1',
        expect.anything()
      );
    });

    it('waits for a connection that is still handshaking', async () => {
      const { connection, fireOnce } = await join(
        manager,
        { receive: false },
        { status: 'connecting' }
      );

      expect(manager.enableReceive('vc-1')).toBe(true);
      expect(connection.rejoin).not.toHaveBeenCalled();

      fireOnce('ready');
      expect(connection.rejoin).toHaveBeenCalledWith({
        channelId: 'vc-1',
        selfDeaf: false,
        selfMute: true,
      });
    });
  });

  describe('disconnectOldest', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function joinAt(
      at: number,
      id: string,
      options?: { receive?: boolean }
    ) {
      vi.setSystemTime(at);
      // Discord allows one connection per guild, so each is its own guild.
      return join(manager, options, { id, guildId: `guild-${id}` });
    }

    it('sheds the connections holding audio buffers before reading-only joins', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await joinAt(1_000, 'tts-oldest', { receive: false });
      await joinAt(2_000, 'silent');
      await joinAt(3_000, 'ring-newer');
      await joinAt(2_500, 'ring-older');
      ringHolders.add('ring-newer').add('ring-older');

      await manager.disconnectOldest(1);
      expect([...manager.getAllConnections().keys()].sort()).toEqual(
        ['ring-newer', 'silent', 'tts-oldest'].sort()
      );

      await manager.disconnectOldest(1);
      expect([...manager.getAllConnections().keys()].sort()).toEqual(
        ['silent', 'tts-oldest'].sort()
      );

      // A listening connection with no buffer yet still goes before reading.
      await manager.disconnectOldest(1);
      expect([...manager.getAllConnections().keys()]).toEqual(['tts-oldest']);

      await manager.disconnectOldest(1);
      expect(manager.getConnectionCount()).toBe(0);
    });
  });

  describe('onDisconnect', () => {
    it('notifies listeners when a channel is disconnected', async () => {
      const listener = vi.fn();
      manager.onDisconnect(listener);
      await join(manager);

      await manager.disconnect('vc-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('vc-1');
    });

    it('stops notifying after unsubscribe', async () => {
      const kept = vi.fn();
      const dropped = vi.fn();
      manager.onDisconnect(kept);
      const unsubscribe = manager.onDisconnect(dropped);
      await join(manager);

      unsubscribe();
      await manager.disconnect('vc-1');

      expect(kept).toHaveBeenCalledWith('vc-1');
      expect(dropped).not.toHaveBeenCalled();
    });

    it('does not notify for a channel that was never connected', async () => {
      const listener = vi.fn();
      manager.onDisconnect(listener);

      await manager.disconnect('vc-unknown');

      expect(listener).not.toHaveBeenCalled();
    });

    it('keeps notifying the rest when one listener throws', async () => {
      const after = vi.fn();
      manager.onDisconnect(() => {
        throw new Error('listener broke');
      });
      manager.onDisconnect(after);
      await join(manager);

      await manager.disconnect('vc-1');

      expect(after).toHaveBeenCalledWith('vc-1');
      expect(logger.error).toHaveBeenCalledWith(
        'Disconnect listener failed for vc-1:',
        'listener broke'
      );
    });

    it('notifies even when tearing the connection down fails', async () => {
      const listener = vi.fn();
      manager.onDisconnect(listener);
      const { connection, player } = await join(manager);
      connection.destroy.mockImplementation(() => {
        throw new Error('already destroyed');
      });

      await manager.disconnect('vc-1');

      expect(listener).toHaveBeenCalledWith('vc-1');
      expect(player.stop).toHaveBeenCalledWith(true);
      expect(manager.getPlayer('vc-1')).toBeUndefined();
      expect(manager.getConnection('vc-1')).toBeUndefined();
    });

    it('notifies when the connection is lost and does not recover', async () => {
      const listener = vi.fn();
      manager.onDisconnect(listener);
      const { fire, player } = await join(manager);
      entersState.mockRejectedValue(new Error('timed out'));

      await fire('disconnected');

      expect(listener).toHaveBeenCalledWith('vc-1');
      expect(player.stop).toHaveBeenCalledWith(true);
      expect(manager.getPlayer('vc-1')).toBeUndefined();
    });

    it('does not notify when a dropped connection recovers', async () => {
      const listener = vi.fn();
      manager.onDisconnect(listener);
      const { fire, player } = await join(manager);
      entersState.mockResolvedValue(undefined);

      await fire('disconnected');

      expect(listener).not.toHaveBeenCalled();
      expect(manager.getPlayer('vc-1')).toBe(player);
    });
  });
});
