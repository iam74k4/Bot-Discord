import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryMonitorCreated = vi.fn();
const memoryMonitorStart = vi.fn();
const memoryMonitorStop = vi.fn();
const fileCleanupCreated = vi.fn();
const fileCleanupStart = vi.fn();
const fileCleanupStop = vi.fn();
const disconnect = vi.fn();
const getAllConnections = vi.fn(() => new Map<string, unknown>());
const setServiceStatus = vi.fn();
const reconcileOccupiedVoiceChannels = vi.fn().mockResolvedValue(undefined);
const unsubscribe = vi.fn();
const onDisconnect = vi.fn(
  (_listener: (channelId: string) => void) => unsubscribe
);
const ttsSessions = { handleDisconnect: vi.fn(), stopAll: vi.fn() };

vi.mock('../jobs/memoryMonitor.js', () => ({
  MemoryMonitor: class {
    constructor(config: unknown) {
      memoryMonitorCreated(config);
    }
    start = memoryMonitorStart;
    stop = memoryMonitorStop;
  },
}));

vi.mock('../jobs/fileCleanup.js', () => ({
  FileCleanupService: class {
    constructor(config: unknown) {
      fileCleanupCreated(config);
    }
    start = fileCleanupStart;
    stop = fileCleanupStop;
  },
}));

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    disconnect,
    getAllConnections,
    onDisconnect,
  },
}));

vi.mock('../tts/sessionManager.js', () => ({ ttsSessions }));

vi.mock('../application/reconcile.js', () => ({
  reconcileOccupiedVoiceChannels,
}));

vi.mock('../../../infrastructure/health/index.js', () => ({
  setServiceStatus,
}));

describe('voice feature lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getAllConnections.mockReturnValue(new Map());
    reconcileOccupiedVoiceChannels.mockResolvedValue(undefined);
    disconnect.mockResolvedValue(undefined);
    onDisconnect.mockImplementation(() => unsubscribe);
  });

  it('ends a reading session when its voice connection goes away', async () => {
    const { start, stop } = await import('../index.js');
    await start({ client: {}, config: {} } as never);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    const listener = onDisconnect.mock.calls[0][0];
    listener('vc-1');
    expect(ttsSessions.handleDisconnect).toHaveBeenCalledWith('vc-1');

    await stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stops every reading session before leaving the voice channels', async () => {
    const order: string[] = [];
    ttsSessions.stopAll.mockImplementation(() => order.push('stopAll'));
    disconnect.mockImplementation(async (channelId: string) => {
      order.push(`disconnect:${channelId}`);
    });
    getAllConnections.mockReturnValue(new Map([['vc-1', {}]]));
    const { start, stop } = await import('../index.js');
    await start({ client: {}, config: {} } as never);

    await stop();

    expect(order).toEqual(['stopAll', 'disconnect:vc-1']);
  });

  it('is registered under the name "voice"', async () => {
    const { name } = await import('../index.js');

    expect(name).toBe('voice');
  });

  it('restarts voice jobs after stop and start and reconciles occupied channels', async () => {
    const { start, stop } = await import('../index.js');
    const client = {} as never;
    const context = { client, config: {} } as never;

    await start(context);
    await stop();
    await start(context);

    expect(memoryMonitorStart).toHaveBeenCalledTimes(2);
    expect(memoryMonitorStop).toHaveBeenCalledTimes(1);
    expect(fileCleanupStart).toHaveBeenCalledTimes(2);
    expect(fileCleanupStop).toHaveBeenCalledTimes(1);
    expect(reconcileOccupiedVoiceChannels).toHaveBeenCalledTimes(2);
    expect(reconcileOccupiedVoiceChannels).toHaveBeenCalledWith(client);
  });

  it('builds both jobs from the configuration it is started with', async () => {
    const { start } = await import('../index.js');
    const config = { MEMORY_LIMIT_MB: 512 };

    await start({ client: {}, config } as never);

    expect(memoryMonitorCreated).toHaveBeenCalledWith(config);
    expect(fileCleanupCreated).toHaveBeenCalledWith(config);
  });

  it('does not build any job merely by being imported', async () => {
    await import('../index.js');

    expect(memoryMonitorCreated).not.toHaveBeenCalled();
    expect(fileCleanupCreated).not.toHaveBeenCalled();
  });

  it('reports both jobs healthy on start and down on stop', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    expect(setServiceStatus).toHaveBeenCalledWith('voiceMemoryMonitor', true);
    expect(setServiceStatus).toHaveBeenCalledWith('voiceFileCleanup', true);

    setServiceStatus.mockClear();
    await stop();
    expect(setServiceStatus).toHaveBeenCalledWith('voiceMemoryMonitor', false);
    expect(setServiceStatus).toHaveBeenCalledWith('voiceFileCleanup', false);
  });

  it('starts the jobs before reconciling, so a slow reconcile does not delay them', async () => {
    const { start } = await import('../index.js');

    await start({ client: {}, config: {} } as never);

    expect(memoryMonitorStart.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileOccupiedVoiceChannels.mock.invocationCallOrder[0]
    );
    expect(fileCleanupStart.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileOccupiedVoiceChannels.mock.invocationCallOrder[0]
    );
  });

  it('leaves every voice channel on stop', async () => {
    getAllConnections.mockReturnValue(
      new Map([
        ['voice-1', { guildId: 'guild-1' }],
        ['voice-2', { guildId: 'guild-2' }],
      ])
    );
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await stop();

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith('voice-1');
    expect(disconnect).toHaveBeenCalledWith('voice-2');
  });

  it('can be stopped safely without having been started', async () => {
    const { stop } = await import('../index.js');

    await expect(stop()).resolves.toBeUndefined();

    expect(memoryMonitorStop).not.toHaveBeenCalled();
    expect(fileCleanupStop).not.toHaveBeenCalled();
    expect(setServiceStatus).toHaveBeenCalledWith('voiceMemoryMonitor', false);
  });

  it('does not stop the same job twice when stopped twice', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await stop();
    await stop();

    expect(memoryMonitorStop).toHaveBeenCalledTimes(1);
    expect(fileCleanupStop).toHaveBeenCalledTimes(1);
  });
});
