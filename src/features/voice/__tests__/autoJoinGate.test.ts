import { ChannelType } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const getConnection = vi.hoisted(() => vi.fn().mockReturnValue(undefined));
const getAllConnections = vi.hoisted(() => vi.fn().mockReturnValue(new Map()));
const isAtLimit = vi.hoisted(() => vi.fn().mockReturnValue(false));
const updateActivity = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mayAutoJoin = vi.hoisted(() => vi.fn().mockReturnValue(true));
const announceBuffering = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined)
);

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    connect,
    disconnect,
    getConnection,
    getAllConnections,
    getConnectedChannelInGuild: vi.fn().mockReturnValue(undefined),
    isAtLimit,
    updateActivity,
  },
}));

vi.mock('../application/reconcile.js', () => ({
  reconcileGuild: vi.fn().mockResolvedValue({ status: 'none' }),
}));

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: {
    mayAutoJoin,
    isAutoJoinEnabled: vi.fn().mockReturnValue(true),
    isChannelExcluded: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../application/announce.js', () => ({
  announceBuffering,
  forgetAnnouncement: vi.fn(),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const { event } = await import('../events/voiceStateUpdate.js');

function voiceChannel(id = 'voice-1') {
  const members = new Map([
    ['human-1', { id: 'human-1', user: { bot: false, id: 'human-1' } }],
  ]);
  return {
    id,
    name: 'General',
    type: ChannelType.GuildVoice,
    members: {
      filter: (fn: (m: unknown) => boolean) =>
        new Map([...members].filter(([, m]) => fn(m))),
    },
  };
}

function states(channel: ReturnType<typeof voiceChannel> | null) {
  const guild = { id: 'guild-1', name: 'Guild' };
  return {
    oldState: { channel: null, guild, member: { user: { id: 'human-1' } } },
    newState: { channel, guild, member: { user: { id: 'human-1' } } },
  };
}

const client = { isFullyReady: true, user: { id: 'bot-1' } };

describe('voice auto-join gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnection.mockReturnValue(undefined);
    isAtLimit.mockReturnValue(false);
    connect.mockResolvedValue({});
  });

  it('joins and discloses buffering when the guild allows it', async () => {
    mayAutoJoin.mockReturnValue(true);
    const { oldState, newState } = states(voiceChannel());

    await event.execute(client as never, oldState as never, newState as never);

    expect(connect).toHaveBeenCalled();
    // People in the channel must be told their audio is being kept.
    expect(announceBuffering).toHaveBeenCalled();
  });

  it('does not join a channel the server excluded', async () => {
    mayAutoJoin.mockReturnValue(false);
    const { oldState, newState } = states(voiceChannel('excluded-1'));

    await event.execute(client as never, oldState as never, newState as never);

    expect(connect).not.toHaveBeenCalled();
    expect(announceBuffering).not.toHaveBeenCalled();
  });

  it('does not disclose when the join itself failed', async () => {
    mayAutoJoin.mockReturnValue(true);
    connect.mockResolvedValue(null);
    const { oldState, newState } = states(voiceChannel());

    await event.execute(client as never, oldState as never, newState as never);

    expect(announceBuffering).not.toHaveBeenCalled();
  });
});
