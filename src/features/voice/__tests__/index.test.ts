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
const unhookStatus = vi.fn();
const onBeforeDisconnect = vi.fn(
  (_hook: (channelId: string) => Promise<unknown> | undefined) => unhookStatus
);
const ttsSessions = { handleDisconnect: vi.fn(), stopAll: vi.fn() };
const captionSessions = { handleDisconnect: vi.fn(), stopAll: vi.fn() };
const removeCaptionTap = vi.fn();
const addAudioTap = vi.fn((_tap: unknown) => removeCaptionTap);
const settleBufferingStatus = vi.fn();
const clearStaleBufferingStatuses = vi.fn();

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

const logOpusBackend = vi.fn();
vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    addAudioTap,
    disconnect,
    getAllConnections,
    onDisconnect,
    onBeforeDisconnect,
  },
  logOpusBackend,
}));

vi.mock('../application/voiceChannelStatus.js', () => ({
  settleBufferingStatus,
  clearStaleBufferingStatuses,
}));

vi.mock('../tts/sessionManager.js', () => ({ ttsSessions }));
vi.mock('../captions/sessionManager.js', () => ({ captionSessions }));

const handleConsentClick = vi.fn();
vi.mock('../application/captions.js', () => ({
  CAPTION_CONSENT_PREFIX: 'caption-consent:',
  handleConsentClick,
}));

vi.mock('../application/reconcile.js', () => ({
  reconcileOccupiedVoiceChannels,
}));

vi.mock('../../../infrastructure/health/index.js', () => ({
  setServiceStatus,
}));

const forgetAnnouncement = vi.fn();
vi.mock('../application/announce.js', () => ({
  forgetAnnouncement,
  OPT_OUT_PREFIX: 'voice-optout:',
}));

const handleOptOutClick = vi.fn();
vi.mock('../application/optOut.js', () => ({ handleOptOutClick }));

const warmUpTts = vi.fn();
vi.mock('../application/tts.js', () => ({ warmUpTts }));

const voiceSettingsSummary = vi.fn();
vi.mock('../application/settingsSummary.js', () => ({ voiceSettingsSummary }));
const unregisterSummary = vi.fn();
const registerSettingsSummary = vi.fn(() => unregisterSummary);
vi.mock('../../../shared/settingsSummary/index.js', () => ({
  registerSettingsSummary,
}));

const unregisterOptOut = vi.fn();
const unregisterConsent = vi.fn();
const routeFor = (prefix: string) =>
  prefix === 'caption-consent:' ? unregisterConsent : unregisterOptOut;
const registerComponentHandler = vi.fn((prefix: string, _handler: unknown) =>
  routeFor(prefix)
);
vi.mock('../../../shared/interactions/index.js', () => ({
  registerComponentHandler,
}));

describe('voice feature lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getAllConnections.mockReturnValue(new Map());
    reconcileOccupiedVoiceChannels.mockResolvedValue(undefined);
    disconnect.mockResolvedValue(undefined);
    onDisconnect.mockImplementation(() => unsubscribe);
    onBeforeDisconnect.mockImplementation(() => unhookStatus);
    clearStaleBufferingStatuses.mockResolvedValue(0);
    registerComponentHandler.mockImplementation((prefix: string) =>
      routeFor(prefix)
    );
    addAudioTap.mockImplementation(() => removeCaptionTap);
    registerSettingsSummary.mockImplementation(() => unregisterSummary);
  });

  it('adds its settings to the /admin overview while started', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await start({ client: {}, config: {} } as never);

    expect(registerSettingsSummary).toHaveBeenCalledWith(
      'voice',
      voiceSettingsSummary,
      { order: 30 }
    );
    // A restart replaces the provider instead of stacking a second one.
    expect(unregisterSummary).toHaveBeenCalledTimes(1);

    await stop();
    expect(unregisterSummary).toHaveBeenCalledTimes(2);
  });

  it('routes the opt-out button on notices while started, and stops on stop', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    expect(registerComponentHandler).toHaveBeenCalledWith(
      'voice-optout:',
      handleOptOutClick
    );
    expect(unregisterOptOut).not.toHaveBeenCalled();

    await stop();
    expect(unregisterOptOut).toHaveBeenCalledTimes(1);
  });

  it('registers the button once even when started twice in a row', async () => {
    const { start } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await start({ client: {}, config: {} } as never);

    // The first registration is released before the second is made.
    const optOutRoutes = registerComponentHandler.mock.calls.filter(
      ([prefix]) => prefix === 'voice-optout:'
    );
    expect(optOutRoutes).toHaveLength(2);
    expect(unregisterOptOut).toHaveBeenCalledTimes(1);
  });

  it('routes the caption consent buttons while started, and stops on stop', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await start({ client: {}, config: {} } as never);
    expect(registerComponentHandler).toHaveBeenCalledWith(
      'caption-consent:',
      handleConsentClick
    );
    expect(unregisterConsent).toHaveBeenCalledTimes(1);

    await stop();
    expect(unregisterConsent).toHaveBeenCalledTimes(2);
  });

  it('hands speakers audio to captions while started, once, and stops on stop', async () => {
    const { start, stop } = await import('../index.js');

    await start({ client: {}, config: {} } as never);
    await start({ client: {}, config: {} } as never);
    expect(addAudioTap).toHaveBeenCalledWith(captionSessions);
    expect(removeCaptionTap).toHaveBeenCalledTimes(1);

    await stop();
    expect(removeCaptionTap).toHaveBeenCalledTimes(2);
  });

  it('takes down its notices state for each channel it leaves on stop', async () => {
    getAllConnections.mockReturnValue(new Map([['vc-1', {}]]));
    const { start, stop } = await import('../index.js');
    await start({ client: {}, config: {} } as never);

    await stop();

    expect(forgetAnnouncement).toHaveBeenCalledWith('vc-1');
    expect(forgetAnnouncement.mock.invocationCallOrder[0]).toBeLessThan(
      disconnect.mock.invocationCallOrder[0]
    );
  });

  it('clears its voice channel status before each leave, until stopped', async () => {
    const client = { id: 'client' };
    const pending = Promise.resolve();
    settleBufferingStatus.mockReturnValue(pending);
    getAllConnections.mockReturnValue(new Map([['vc-1', {}]]));
    const { start, stop } = await import('../index.js');
    await start({ client, config: {} } as never);

    expect(onBeforeDisconnect).toHaveBeenCalledTimes(1);
    const hook = onBeforeDisconnect.mock.calls[0][0];
    expect(hook('vc-1')).toBe(pending);
    expect(settleBufferingStatus).toHaveBeenCalledWith('vc-1', client);

    await stop();
    // Unhooked only after the last channel was left, so stop clears too.
    expect(unhookStatus).toHaveBeenCalledTimes(1);
    expect(unhookStatus.mock.invocationCallOrder[0]).toBeGreaterThan(
      disconnect.mock.invocationCallOrder[0]
    );
  });

  it('logs the Opus backend when it starts, before anyone speaks', async () => {
    const { start } = await import('../index.js');

    await start({ client: {}, config: {} } as never);

    expect(logOpusBackend).toHaveBeenCalledTimes(1);
  });

  it('clears statuses an earlier run left behind when it starts', async () => {
    const client = { id: 'client' };
    const { start } = await import('../index.js');

    await start({ client, config: {} } as never);

    expect(clearStaleBufferingStatuses).toHaveBeenCalledWith(client);
  });

  it('warms up the text-to-speech engine when it starts', async () => {
    const { start } = await import('../index.js');

    await start({ client: {}, config: {} } as never);

    expect(warmUpTts).toHaveBeenCalledTimes(1);
  });

  it('ends reading and caption sessions when their voice connection goes away', async () => {
    const { start, stop } = await import('../index.js');
    await start({ client: {}, config: {} } as never);

    expect(onDisconnect).toHaveBeenCalledTimes(2);
    for (const [listener] of onDisconnect.mock.calls) listener('vc-1');
    expect(ttsSessions.handleDisconnect).toHaveBeenCalledWith('vc-1');
    expect(captionSessions.handleDisconnect).toHaveBeenCalledWith('vc-1');

    await stop();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('stops every reading and caption session before leaving the voice channels', async () => {
    const order: string[] = [];
    ttsSessions.stopAll.mockImplementation(() => order.push('stopAll'));
    captionSessions.stopAll.mockImplementation(() =>
      order.push('captions:stopAll')
    );
    disconnect.mockImplementation(async (channelId: string) => {
      order.push(`disconnect:${channelId}`);
    });
    getAllConnections.mockReturnValue(new Map([['vc-1', {}]]));
    const { start, stop } = await import('../index.js');
    await start({ client: {}, config: {} } as never);

    await stop();

    expect(order).toEqual(['stopAll', 'captions:stopAll', 'disconnect:vc-1']);
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
