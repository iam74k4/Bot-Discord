import { EventEmitter } from 'events';
import { PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The parts of the connection manager captions rely on: audio taps that see
 * every speaker's decoded audio, joins that listen without keeping anything
 * in the record ring, and switching a connection between deafened,
 * listening and buffering in place.
 */

const joinVoiceChannel = vi.hoisted(() => vi.fn());
const entersState = vi.hoisted(() => vi.fn());
const createAudioPlayer = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

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
  default: { opus: { Decoder: class {} } },
}));

vi.mock('../../../config/index.js', () => ({
  env: { MAX_CONCURRENT_VC_CONNECTIONS: 5 },
  AUDIO: { SAMPLE_RATE: 48000 },
}));

const ring = vi.hoisted(() => ({
  globalIndexAt: vi.fn(() => 960),
  addMonoPcmInt16At: vi.fn(),
}));
const ringHolders = vi.hoisted(() => new Set<string>());
vi.mock('../recording/channelMixRing.js', () => ({
  channelMixRingManager: {
    getOrCreate: vi.fn(() => ring),
    remove: vi.fn((channelId: string) => ringHolders.delete(channelId)),
    has: vi.fn((channelId: string) => ringHolders.has(channelId)),
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { VoiceConnectionManager } =
  await import('../recording/connectionManager.js');
const { channelMixRingManager } =
  await import('../recording/channelMixRing.js');
const { keepsAudio } = await import('../recording/audioMode.js');

type Manager = InstanceType<typeof VoiceConnectionManager>;

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('close');
  });
}

/** Opus stream from receiver.subscribe(); pipe(decoder) yields `pcm`. */
class FakeOpusStream extends FakeStream {
  readonly pcm = new FakeStream();
  pipe = vi.fn(() => this.pcm);
}

function makeConnection(selfDeaf: boolean) {
  const opusStreams: FakeOpusStream[] = [];
  const connection = {
    joinConfig: { selfDeaf, selfMute: true },
    state: { status: 'ready' },
    subscribe: vi.fn(),
    destroy: vi.fn(),
    rejoin: vi.fn(() => true),
    on: vi.fn(() => connection),
    once: vi.fn(() => connection),
    receiver: {
      speaking: new EventEmitter(),
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
    speak: (userId: string) =>
      connection.receiver.speaking.emit('start', userId),
  };
}

async function join(
  manager: Manager,
  options?: { receive?: boolean; buffer?: boolean },
  id = 'vc-1'
) {
  const channel = {
    id,
    name: `channel-${id}`,
    guild: {
      id: `guild-${id}`,
      name: `guild-${id}`,
      voiceAdapterCreator: vi.fn(),
      members: { me: { id: 'bot' } },
    },
    permissionsFor: vi.fn(() => ({
      has: (flag: bigint) => flag === PermissionFlagsBits.Connect,
    })),
  };
  let fake!: ReturnType<typeof makeConnection>;
  joinVoiceChannel.mockImplementationOnce((config: { selfDeaf: boolean }) => {
    fake = makeConnection(config.selfDeaf);
    return fake.connection;
  });
  await manager.connect(channel.guild as never, channel as never, options);
  return fake;
}

const PCM = Buffer.alloc(1920);

function tap() {
  return { onAudio: vi.fn(), onSpeechEnd: vi.fn() };
}

describe('VoiceConnectionManager (captions support)', () => {
  let manager: Manager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'], now: 5_000 });
    ringHolders.clear();
    entersState.mockResolvedValue(undefined);
    manager = new VoiceConnectionManager();
  });

  describe('audio taps', () => {
    it('hand every decoded chunk to the tap with its speaker and arrival time, and the ring keeps it too', async () => {
      const audio = tap();
      manager.addAudioTap(audio);
      const fake = await join(manager);
      fake.speak('user-1');

      fake.opusStreams[0].pcm.emit('data', PCM);

      expect(audio.onAudio).toHaveBeenCalledWith('vc-1', 'user-1', PCM, 5_000);
      expect(ring.addMonoPcmInt16At).toHaveBeenCalledTimes(1);
    });

    it("tell the tap once when a speaker's stream ends, however it ends", async () => {
      const audio = tap();
      manager.addAudioTap(audio);
      const fake = await join(manager);
      fake.speak('user-1');
      const [stream] = fake.opusStreams;

      stream.pcm.emit('error', new Error('corrupt packet'));
      stream.pcm.emit('close');

      expect(audio.onSpeechEnd).toHaveBeenCalledTimes(1);
      expect(audio.onSpeechEnd).toHaveBeenCalledWith('vc-1', 'user-1');
    });

    it('cost the recording nothing when one throws', async () => {
      const broken = tap();
      broken.onAudio.mockImplementation(() => {
        throw new Error('tap bug');
      });
      broken.onSpeechEnd.mockImplementation(() => {
        throw new Error('tap bug');
      });
      const other = tap();
      manager.addAudioTap(broken);
      manager.addAudioTap(other);
      const fake = await join(manager);
      fake.speak('user-1');

      fake.opusStreams[0].pcm.emit('data', PCM);
      fake.opusStreams[0].pcm.emit('close');

      expect(other.onAudio).toHaveBeenCalledTimes(1);
      expect(other.onSpeechEnd).toHaveBeenCalledTimes(1);
      expect(ring.addMonoPcmInt16At).toHaveBeenCalledTimes(1);
    });

    it('stop hearing anything once removed', async () => {
      const audio = tap();
      const remove = manager.addAudioTap(audio);
      const fake = await join(manager);
      fake.speak('user-1');

      remove();
      fake.opusStreams[0].pcm.emit('data', PCM);

      expect(audio.onAudio).not.toHaveBeenCalled();
    });
  });

  describe('a join that listens without buffering', () => {
    it('hears speakers but keeps nothing in the record ring', async () => {
      const audio = tap();
      manager.addAudioTap(audio);
      const fake = await join(manager, { receive: true, buffer: false });

      expect(joinVoiceChannel).toHaveBeenCalledWith(
        expect.objectContaining({ selfDeaf: false })
      );
      const info = manager.getConnection('vc-1');
      expect(info).toMatchObject({ receiving: true, buffering: false });
      expect(keepsAudio(info!)).toBe(false);

      fake.speak('user-1');
      fake.opusStreams[0].pcm.emit('data', PCM);

      expect(audio.onAudio).toHaveBeenCalledTimes(1);
      expect(channelMixRingManager.getOrCreate).not.toHaveBeenCalled();
    });

    it('never buffers a deafened join, whatever `buffer` says', async () => {
      await join(manager, { receive: false, buffer: true });

      expect(manager.getConnection('vc-1')).toMatchObject({
        receiving: false,
        buffering: false,
      });
    });

    it('is shed with the joins that keep nothing, after buffering ones', async () => {
      vi.setSystemTime(1_000);
      await join(manager, { buffer: false }, 'captions-oldest');
      vi.setSystemTime(2_000);
      await join(manager, undefined, 'buffering-newer');

      await manager.disconnectOldest(1);

      expect([...manager.getAllConnections().keys()]).toEqual([
        'captions-oldest',
      ]);
    });
  });

  describe('enableReceive', () => {
    it('undeafens a reading-only join to listen without buffering', async () => {
      const fake = await join(manager, { receive: false });

      expect(manager.enableReceive('vc-1', { buffer: false })).toBe(true);

      expect(manager.getConnection('vc-1')).toMatchObject({
        receiving: true,
        buffering: false,
      });
      expect(fake.connection.rejoin).toHaveBeenCalledWith(
        expect.objectContaining({ selfDeaf: false })
      );
    });

    it('starts buffering on a join that only listened, without rejoining', async () => {
      const fake = await join(manager, { buffer: false });

      expect(manager.enableReceive('vc-1')).toBe(true);

      expect(manager.getConnection('vc-1')).toMatchObject({
        receiving: true,
        buffering: true,
      });
      expect(fake.connection.rejoin).not.toHaveBeenCalled();
    });

    it('is false when nothing changes', async () => {
      await join(manager, { buffer: false });
      expect(manager.enableReceive('vc-1', { buffer: false })).toBe(false);

      await join(manager, undefined, 'vc-2');
      expect(manager.enableReceive('vc-2')).toBe(false);
    });
  });

  describe('disableReceive', () => {
    it('deafens in place, closes every stream and drops the kept audio', async () => {
      const audio = tap();
      manager.addAudioTap(audio);
      const fake = await join(manager);
      ringHolders.add('vc-1');
      fake.speak('user-1');
      const [stream] = fake.opusStreams;

      expect(manager.disableReceive('vc-1')).toBe(true);

      expect(manager.getConnection('vc-1')).toMatchObject({
        receiving: false,
        buffering: false,
      });
      expect(stream.destroy).toHaveBeenCalled();
      expect(audio.onSpeechEnd).toHaveBeenCalledWith('vc-1', 'user-1');
      expect(channelMixRingManager.remove).toHaveBeenCalledWith('vc-1');
      expect(fake.connection.rejoin).toHaveBeenCalledWith(
        expect.objectContaining({ selfDeaf: true })
      );
      expect(fake.connection.destroy).not.toHaveBeenCalled();
      // Deafened: a new speaker is not subscribed to.
      fake.speak('user-2');
      expect(fake.connection.receiver.subscribe).toHaveBeenCalledTimes(1);
    });

    it('tracks the streams of a later listen again, so a disconnect still closes them', async () => {
      const fake = await join(manager);
      manager.disableReceive('vc-1');
      manager.enableReceive('vc-1');
      fake.speak('user-1');
      const [stream] = fake.opusStreams;

      await manager.disconnect('vc-1');

      expect(stream.destroy).toHaveBeenCalled();
    });

    it('is false for a channel that is not connected or not listening', async () => {
      expect(manager.disableReceive('vc-1')).toBe(false);

      await join(manager, { receive: false });
      expect(manager.disableReceive('vc-1')).toBe(false);
    });
  });
});
