import { ChannelType, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const startSession = vi.fn(() => 1);
const endSession = vi.fn();
const closeAllStaleSessions = vi.fn(() => 0);

vi.mock('../repositories/voiceSessionRepository.js', () => ({
  voiceSessionRepository: {
    startSession,
    endSession,
    closeAllStaleSessions,
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('voiceTracker restart reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('ends in-memory sessions on graceful shutdown', async () => {
    const { voiceTracker } = await import('../tracking/voiceTracker.js');

    voiceTracker.startSession('guild-1', 'user-1', 'ch-1', 'General');
    voiceTracker.startSession('guild-1', 'user-2', 'ch-1', 'General');
    expect(startSession).toHaveBeenCalledTimes(2);

    voiceTracker.endAllSessions();

    expect(endSession).toHaveBeenCalledTimes(2);
    expect(endSession).toHaveBeenCalledWith(1);
    expect(voiceTracker.getActiveSession('guild-1', 'user-1')).toBeUndefined();
    expect(voiceTracker.getActiveSession('guild-1', 'user-2')).toBeUndefined();
  });

  it('starts sessions for users already in voice after restart', async () => {
    const { voiceTracker } = await import('../tracking/voiceTracker.js');

    const members = new Collection([
      ['user-1', { id: 'user-1', user: { id: 'user-1', bot: false } }],
      ['bot-1', { id: 'bot-1', user: { id: 'bot-1', bot: true } }],
    ]);

    const channel = {
      id: 'ch-1',
      name: 'General',
      type: ChannelType.GuildVoice,
      members,
    };

    const guild = {
      id: 'guild-1',
      channels: {
        cache: new Collection([[channel.id, channel]]),
      },
    };

    const client = {
      guilds: {
        cache: new Collection([[guild.id, guild]]),
      },
    } as never;

    voiceTracker.closeAllStaleSessions();
    voiceTracker.reconcileActiveVoiceSessions(client);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      'guild-1',
      'user-1',
      'ch-1',
      'General'
    );
    expect(voiceTracker.getActiveSession('guild-1', 'user-1')).toEqual(
      expect.objectContaining({
        sessionId: 1,
        channelId: 'ch-1',
        channelName: 'General',
      })
    );
  });

  it('does not count members idling in the AFK channel after restart', async () => {
    const { voiceTracker } = await import('../tracking/voiceTracker.js');

    const voiceChannel = (id: string, userId: string) => ({
      id,
      name: id,
      type: ChannelType.GuildVoice,
      members: new Collection([
        [userId, { id: userId, user: { id: userId, bot: false } }],
      ]),
    });
    const afk = voiceChannel('afk', 'idle-user');
    const lounge = voiceChannel('lounge', 'active-user');
    const guild = {
      id: 'guild-1',
      afkChannelId: 'afk',
      channels: {
        cache: new Collection([
          [afk.id, afk],
          [lounge.id, lounge],
        ]),
      },
    };

    voiceTracker.reconcileActiveVoiceSessions({
      guilds: { cache: new Collection([[guild.id, guild]]) },
    } as never);

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      'guild-1',
      'active-user',
      'lounge',
      'lounge'
    );
    expect(voiceTracker.getActiveSession('guild-1', 'idle-user')).toBe(
      undefined
    );
  });
});
