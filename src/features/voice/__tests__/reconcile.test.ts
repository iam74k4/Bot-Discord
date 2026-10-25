import { ChannelType, Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.fn();
const disconnect = vi.fn();
const getAllConnections = vi.fn(() => new Map());
const isAtLimit = vi.fn(() => false);
const isAutoJoinEnabled = vi.fn((_guildId: string) => true);
const isChannelExcluded = vi.fn(
  (_guildId: string, _channelId: string) => false
);
const announceBuffering = vi.fn();
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    connect,
    disconnect,
    getAllConnections,
    getConnectedChannelInGuild: (guildId: string) => {
      for (const info of getAllConnections().values()) {
        const { guildId: owner, channelId } = info as {
          guildId: string;
          channelId: string;
        };
        if (owner === guildId) return channelId;
      }
      return undefined;
    },
    isAtLimit,
  },
}));

// Mocked rather than real so these never open the on-disk test database.
vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: { isAutoJoinEnabled, isChannelExcluded },
}));

vi.mock('../application/announce.js', () => ({ announceBuffering }));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

function makeMember(id: string, bot = false) {
  return {
    id,
    user: { id, bot },
  };
}

function makeVoiceChannel(
  id: string,
  name: string,
  members: ReturnType<typeof makeMember>[],
  type: ChannelType = ChannelType.GuildVoice
) {
  const memberCollection = new Collection<
    string,
    ReturnType<typeof makeMember>
  >();
  for (const member of members) {
    memberCollection.set(member.id, member);
  }
  return {
    id,
    name,
    type,
    members: memberCollection,
  };
}

function makeGuild(id: string, channels: unknown[]) {
  return {
    id,
    name: `Guild ${id}`,
    channels: {
      cache: new Collection(
        channels.map((channel, i) => [
          (channel as { id?: string } | null)?.id ?? `stray-${i}`,
          channel,
        ])
      ),
    },
  };
}

function makeClient(guilds: ReturnType<typeof makeGuild>[]) {
  return {
    guilds: {
      cache: new Collection(guilds.map((guild) => [guild.id, guild])),
    },
  } as never;
}

async function reconcile(client: never) {
  const { reconcileOccupiedVoiceChannels } =
    await import('../application/reconcile.js');
  await reconcileOccupiedVoiceChannels(client);
}

async function reconcileOne(guild: unknown) {
  const { reconcileGuild } = await import('../application/reconcile.js');
  return reconcileGuild(guild as never);
}

describe('reconcileOccupiedVoiceChannels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getAllConnections.mockReturnValue(new Map());
    isAtLimit.mockReturnValue(false);
    isAutoJoinEnabled.mockReturnValue(true);
    isChannelExcluded.mockReturnValue(false);
    connect.mockResolvedValue({ id: 'connection' });
    disconnect.mockResolvedValue(undefined);
    announceBuffering.mockResolvedValue(undefined);
  });

  it('auto-joins the busiest occupied channel after restart', async () => {
    const quiet = makeVoiceChannel('ch-quiet', 'Quiet', [makeMember('u1')]);
    const busy = makeVoiceChannel('ch-busy', 'Busy', [
      makeMember('u2'),
      makeMember('u3'),
    ]);
    const empty = makeVoiceChannel('ch-empty', 'Empty', []);

    const guild = {
      id: 'guild-1',
      name: 'Guild',
      channels: {
        cache: new Collection([
          [quiet.id, quiet],
          [busy.id, busy],
          [empty.id, empty],
        ]),
      },
    };

    const client = {
      guilds: {
        cache: new Collection([[guild.id, guild]]),
      },
    } as never;

    const { reconcileOccupiedVoiceChannels } =
      await import('../application/reconcile.js');
    await reconcileOccupiedVoiceChannels(client);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][1]).toBe(busy);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('skips guilds that already have a tracked connection', async () => {
    const occupied = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);
    const guild = {
      id: 'guild-1',
      name: 'Guild',
      channels: {
        cache: new Collection([[occupied.id, occupied]]),
      },
    };
    getAllConnections.mockReturnValue(
      new Map([
        ['other-channel', { guildId: 'guild-1', channelId: 'other-channel' }],
      ])
    );

    const client = {
      guilds: {
        cache: new Collection([[guild.id, guild]]),
      },
    } as never;

    const { reconcileOccupiedVoiceChannels } =
      await import('../application/reconcile.js');
    await reconcileOccupiedVoiceChannels(client);

    expect(connect).not.toHaveBeenCalled();
  });

  it('disconnects when the channel empties during connect', async () => {
    const occupied = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);
    connect.mockImplementation(async () => {
      occupied.members.clear();
      return { id: 'connection' };
    });

    const guild = {
      id: 'guild-1',
      name: 'Guild',
      channels: {
        cache: new Collection([[occupied.id, occupied]]),
      },
    };

    const client = {
      guilds: {
        cache: new Collection([[guild.id, guild]]),
      },
    } as never;

    const { reconcileOccupiedVoiceChannels } =
      await import('../application/reconcile.js');
    await reconcileOccupiedVoiceChannels(client);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith('ch-1');
    expect(announceBuffering).not.toHaveBeenCalled();
  });

  it('stops when the connection limit is reached', async () => {
    isAtLimit.mockReturnValue(true);
    const occupied = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);
    const guild = {
      id: 'guild-1',
      name: 'Guild',
      channels: {
        cache: new Collection([[occupied.id, occupied]]),
      },
    };

    const client = {
      guilds: {
        cache: new Collection([[guild.id, guild]]),
      },
    } as never;

    const { reconcileOccupiedVoiceChannels } =
      await import('../application/reconcile.js');
    await reconcileOccupiedVoiceChannels(client);

    expect(connect).not.toHaveBeenCalled();
  });

  it('discloses the buffering in the channel it joined', async () => {
    const general = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);
    const guild = makeGuild('guild-1', [general]);

    await reconcile(makeClient([guild]));

    expect(connect).toHaveBeenCalledWith(guild, general);
    expect(announceBuffering).toHaveBeenCalledWith(general);
  });

  it('leaves guilds that disabled auto-join alone and carries on with the rest', async () => {
    const optedOut = makeGuild('guild-off', [
      makeVoiceChannel('ch-off', 'Off', [makeMember('u1')]),
    ]);
    const lounge = makeVoiceChannel('ch-on', 'On', [makeMember('u2')]);
    const optedIn = makeGuild('guild-on', [lounge]);
    isAutoJoinEnabled.mockImplementation((id: string) => id !== 'guild-off');

    await reconcile(makeClient([optedOut, optedIn]));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(optedIn, lounge);
  });

  it('never picks an excluded channel, even when it is the busiest', async () => {
    const privateRoom = makeVoiceChannel('ch-private', 'Private', [
      makeMember('u1'),
      makeMember('u2'),
      makeMember('u3'),
    ]);
    const general = makeVoiceChannel('ch-general', 'General', [
      makeMember('u4'),
    ]);
    const guild = makeGuild('guild-1', [privateRoom, general]);
    isChannelExcluded.mockImplementation(
      (_guildId: string, channelId: string) => channelId === 'ch-private'
    );

    await reconcile(makeClient([guild]));

    expect(isChannelExcluded).toHaveBeenCalledWith('guild-1', 'ch-private');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(guild, general);
  });

  it('does not join when the only occupied channel is excluded', async () => {
    const privateRoom = makeVoiceChannel('ch-private', 'Private', [
      makeMember('u1'),
    ]);
    isChannelExcluded.mockReturnValue(true);

    await reconcile(makeClient([makeGuild('guild-1', [privateRoom])]));

    expect(connect).not.toHaveBeenCalled();
  });

  it('counts only humans when choosing a channel', async () => {
    const bots = makeVoiceChannel('ch-bots', 'Bots', [
      makeMember('b1', true),
      makeMember('b2', true),
      makeMember('b3', true),
    ]);
    const people = makeVoiceChannel('ch-people', 'People', [makeMember('u1')]);
    const guild = makeGuild('guild-1', [bots, people]);

    await reconcile(makeClient([guild]));

    expect(connect).toHaveBeenCalledWith(guild, people);
  });

  it('does not join a channel occupied only by bots', async () => {
    const bots = makeVoiceChannel('ch-bots', 'Bots', [makeMember('b1', true)]);

    await reconcile(makeClient([makeGuild('guild-1', [bots])]));

    expect(connect).not.toHaveBeenCalled();
  });

  it('considers stage channels and ignores anything that is not voice', async () => {
    const text = makeVoiceChannel(
      'ch-text',
      'chat',
      [makeMember('u1'), makeMember('u2'), makeMember('u3')],
      ChannelType.GuildText
    );
    const memberless = { id: 'ch-odd', type: ChannelType.GuildVoice };
    const stage = makeVoiceChannel(
      'ch-stage',
      'Stage',
      [makeMember('u4')],
      ChannelType.GuildStageVoice
    );
    const guild = makeGuild('guild-1', [text, memberless, null, stage]);

    await reconcile(makeClient([guild]));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(guild, stage);
  });

  it('keeps the first channel found when two are equally busy', async () => {
    const first = makeVoiceChannel('ch-a', 'A', [makeMember('u1')]);
    const second = makeVoiceChannel('ch-b', 'B', [makeMember('u2')]);
    const guild = makeGuild('guild-1', [first, second]);

    await reconcile(makeClient([guild]));

    expect(connect).toHaveBeenCalledWith(guild, first);
  });

  it("is not blocked by another guild's connection", async () => {
    const general = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);
    getAllConnections.mockReturnValue(
      new Map([['elsewhere', { guildId: 'guild-2', channelId: 'elsewhere' }]])
    );

    await reconcile(makeClient([makeGuild('guild-1', [general])]));

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('moves on to the next guild when a connect fails', async () => {
    const first = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'One', [makeMember('u1')]),
    ]);
    const second = makeGuild('guild-2', [
      makeVoiceChannel('ch-2', 'Two', [makeMember('u2')]),
    ]);
    connect.mockResolvedValueOnce(null);

    await reconcile(makeClient([first, second]));

    expect(connect).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to connect to One (ch-1)')
    );
    expect(announceBuffering).toHaveBeenCalledTimes(1);
  });

  it('logs and survives a connect that throws, then reconciles the next guild', async () => {
    const first = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'One', [makeMember('u1')]),
    ]);
    const secondChannel = makeVoiceChannel('ch-2', 'Two', [makeMember('u2')]);
    const second = makeGuild('guild-2', [secondChannel]);
    connect.mockRejectedValueOnce(new Error('gateway timeout'));

    await expect(reconcile(makeClient([first, second]))).resolves.toBe(
      undefined
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Voice reconcile error for guild guild-1:',
      'gateway timeout'
    );
    expect(announceBuffering).toHaveBeenCalledWith(secondChannel);
  });

  it('stops part-way once the limit is reached', async () => {
    const first = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'One', [makeMember('u1')]),
    ]);
    const second = makeGuild('guild-2', [
      makeVoiceChannel('ch-2', 'Two', [makeMember('u2')]),
    ]);
    isAtLimit.mockReturnValueOnce(false).mockReturnValue(true);

    await reconcile(makeClient([first, second]));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toBe(first);
    expect(isAutoJoinEnabled).not.toHaveBeenCalledWith('guild-2');
  });

  it('does not resume the scan when a slot frees up after the limit was hit', async () => {
    const first = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'One', [makeMember('u1')]),
    ]);
    const second = makeGuild('guild-2', [
      makeVoiceChannel('ch-2', 'Two', [makeMember('u2')]),
    ]);
    const third = makeGuild('guild-3', [
      makeVoiceChannel('ch-3', 'Three', [makeMember('u3')]),
    ]);
    // Full on reaching guild-2; a connection drops before guild-3.
    isAtLimit
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await reconcile(makeClient([first, second, third]));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0]).toBe(first);
    expect(isAtLimit).toHaveBeenCalledTimes(2);
    const limitWarnings = logger.warn.mock.calls.filter(([message]) =>
      String(message).includes('Connection limit reached')
    );
    expect(limitWarnings).toHaveLength(1);
  });

  it('does nothing without any guilds', async () => {
    await reconcile(makeClient([]));

    expect(connect).not.toHaveBeenCalled();
  });

  it("joins the next guild without waiting for the first guild's notice to be posted", async () => {
    // A notice that never finishes sending (a slow REST call).
    announceBuffering.mockReturnValue(new Promise(() => undefined));
    const first = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'One', [makeMember('u1')]),
    ]);
    const second = makeGuild('guild-2', [
      makeVoiceChannel('ch-2', 'Two', [makeMember('u2')]),
    ]);

    await reconcile(makeClient([first, second]));

    expect(connect).toHaveBeenCalledTimes(2);
    expect(announceBuffering).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileGuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getAllConnections.mockReturnValue(new Map());
    isAtLimit.mockReturnValue(false);
    isAutoJoinEnabled.mockReturnValue(true);
    isChannelExcluded.mockReturnValue(false);
    connect.mockResolvedValue({ id: 'connection' });
    disconnect.mockResolvedValue(undefined);
    announceBuffering.mockResolvedValue(undefined);
  });

  it('reports the channel it joined', async () => {
    const general = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);

    await expect(
      reconcileOne(makeGuild('guild-1', [general]))
    ).resolves.toEqual({ status: 'joined', channelId: 'ch-1' });
  });

  it('reports the channel it is already in, without joining another', async () => {
    getAllConnections.mockReturnValue(
      new Map([['ch-9', { guildId: 'guild-1', channelId: 'ch-9' }]])
    );
    const general = makeVoiceChannel('ch-1', 'General', [makeMember('u1')]);

    await expect(
      reconcileOne(makeGuild('guild-1', [general]))
    ).resolves.toEqual({ status: 'already', channelId: 'ch-9' });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['nobody is in voice', [], 'none'],
    ['the only people are in an excluded channel', ['excluded'], 'none'],
  ])('reports that %s', async (_label, flags, status) => {
    isChannelExcluded.mockReturnValue(flags.includes('excluded'));
    const channel = makeVoiceChannel(
      'ch-1',
      'General',
      flags.length > 0 ? [makeMember('u1')] : []
    );

    await expect(
      reconcileOne(makeGuild('guild-1', [channel]))
    ).resolves.toEqual({ status });
  });

  it('reports auto-join off, the limit, and a failed join', async () => {
    const guild = makeGuild('guild-1', [
      makeVoiceChannel('ch-1', 'General', [makeMember('u1')]),
    ]);

    isAutoJoinEnabled.mockReturnValueOnce(false);
    await expect(reconcileOne(guild)).resolves.toEqual({ status: 'disabled' });

    isAtLimit.mockReturnValueOnce(true);
    await expect(reconcileOne(guild)).resolves.toEqual({ status: 'limit' });

    connect.mockResolvedValueOnce(null);
    await expect(reconcileOne(guild)).resolves.toEqual({ status: 'failed' });
  });
});
