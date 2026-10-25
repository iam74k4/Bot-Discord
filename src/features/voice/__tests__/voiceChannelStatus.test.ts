import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const waitUntilReady = vi.hoisted(() => vi.fn());
const getConnection = vi.hoisted(() => vi.fn());
vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: { waitUntilReady, getConnection },
}));

const {
  SET_VOICE_CHANNEL_STATUS,
  clearBufferingStatus,
  clearStaleBufferingStatuses,
  isBotStatusText,
  knownVoiceChannelStatus,
  observeGatewayPacket,
  resetVoiceChannelStatuses,
  setBufferingStatus,
  settleBufferingStatus,
} = await import('../application/voiceChannelStatus.js');
const { event } = await import('../events/voiceChannelStatus.js');
const { t } = await import('../../../locales/index.js');
const { logger } = await import('../../../shared/utils/logger.js');

const TEXT = '🔴 Bot is keeping the last 5 min of audio';
const JA_TEXT = t('record.notice.channelStatus', 'ja', { minutes: 5 });

function channelStub(
  options: {
    id?: string;
    type?: ChannelType;
    canSetStatus?: boolean;
  } = {}
) {
  const put = vi.fn(async () => undefined);
  return {
    put,
    channel: {
      id: options.id ?? 'vc-1',
      type: options.type ?? ChannelType.GuildVoice,
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({
        has: (flag: bigint) =>
          flag === SET_VOICE_CHANNEL_STATUS && options.canSetStatus !== false,
      }),
      client: { rest: { put } },
    },
  };
}

function seeStatus(channelId: string, status: string | null) {
  observeGatewayPacket({
    t: 'VOICE_CHANNEL_STATUS_UPDATE',
    d: { id: channelId, guild_id: 'g', status },
  });
}

describe('voice channel status tracking', () => {
  beforeEach(() => {
    resetVoiceChannelStatuses();
  });

  it('learns statuses from GUILD_CREATE voice channels that carry the field', () => {
    observeGatewayPacket({
      t: 'GUILD_CREATE',
      d: {
        channels: [
          { id: 'empty', type: ChannelType.GuildVoice, status: null },
          { id: 'busy', type: ChannelType.GuildVoice, status: 'Gaming' },
          { id: 'unknown', type: ChannelType.GuildVoice },
          { id: 'text', type: ChannelType.GuildText, status: '' },
        ],
      },
    });

    expect(knownVoiceChannelStatus('empty')).toBe('');
    expect(knownVoiceChannelStatus('busy')).toBe('Gaming');
    // No field, no knowledge: never treated as empty.
    expect(knownVoiceChannelStatus('unknown')).toBeUndefined();
    expect(knownVoiceChannelStatus('text')).toBeUndefined();
  });

  it('follows status updates and forgets deleted channels', () => {
    seeStatus('vc-1', 'Movie night');
    expect(knownVoiceChannelStatus('vc-1')).toBe('Movie night');

    seeStatus('vc-1', null);
    expect(knownVoiceChannelStatus('vc-1')).toBe('');

    observeGatewayPacket({ t: 'CHANNEL_DELETE', d: { id: 'vc-1' } });
    expect(knownVoiceChannelStatus('vc-1')).toBeUndefined();
  });

  it('ignores unrelated and malformed packets', () => {
    expect(() => {
      observeGatewayPacket({ t: 'MESSAGE_CREATE', d: { id: 'x' } });
      observeGatewayPacket({ t: 'GUILD_CREATE', d: null });
      observeGatewayPacket({ t: 'VOICE_CHANNEL_STATUS_UPDATE', d: {} });
      observeGatewayPacket({ t: null });
    }).not.toThrow();
    expect(knownVoiceChannelStatus('x')).toBeUndefined();
  });

  it('is fed by the raw gateway event', async () => {
    expect(event.name).toBe('raw');

    await event.execute(
      {} as never,
      {
        t: 'VOICE_CHANNEL_STATUS_UPDATE',
        d: { id: 'vc-7', status: 'Study' },
      } as never
    );

    expect(knownVoiceChannelStatus('vc-7')).toBe('Study');
  });
});

describe('setBufferingStatus / clearBufferingStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceChannelStatuses();
    waitUntilReady.mockResolvedValue(true);
  });

  it('sets the status of an empty channel once the bot is connected', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(waitUntilReady).toHaveBeenCalledWith('vc-1', expect.any(Number));
    expect(put).toHaveBeenCalledWith('/channels/vc-1/voice-status', {
      body: { status: TEXT },
    });
    expect(knownVoiceChannelStatus('vc-1')).toBe(TEXT);
  });

  it('never overwrites a status someone else set', async () => {
    seeStatus('vc-1', 'Movie night');
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(put).not.toHaveBeenCalled();
  });

  it('leaves a channel alone whose status it has never seen', async () => {
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ['without the permission', { canSetStatus: false }],
    ['in a stage channel', { type: ChannelType.GuildStageVoice }],
  ])('does nothing %s', async (_label, options) => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub(options);

    await setBufferingStatus(channel as never, TEXT);

    expect(put).not.toHaveBeenCalled();
  });

  it('gives up when the connection never becomes ready', async () => {
    seeStatus('vc-1', null);
    waitUntilReady.mockResolvedValue(false);
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(put).not.toHaveBeenCalled();
  });

  it('backs off when a member sets a status while the bot is connecting', async () => {
    seeStatus('vc-1', null);
    waitUntilReady.mockImplementation(async () => {
      seeStatus('vc-1', 'Just set');
      return true;
    });
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(put).not.toHaveBeenCalled();
  });

  it('sets it only once when two announcements race', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();

    await Promise.all([
      setBufferingStatus(channel as never, TEXT),
      setBufferingStatus(channel as never, TEXT),
    ]);

    expect(put).toHaveBeenCalledTimes(1);
  });

  it('swallows API errors so the voice connection is unaffected', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    put.mockRejectedValueOnce(new Error('Missing Access'));

    await expect(
      setBufferingStatus(channel as never, TEXT)
    ).resolves.toBeUndefined();
    // A later attempt is allowed again.
    await setBufferingStatus(channel as never, TEXT);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('clears the status it set when the bot leaves', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    await setBufferingStatus(channel as never, TEXT);
    seeStatus('vc-1', TEXT); // Discord echoes it back

    await clearBufferingStatus('vc-1');

    expect(put).toHaveBeenLastCalledWith('/channels/vc-1/voice-status', {
      body: { status: '' },
    });
    expect(knownVoiceChannelStatus('vc-1')).toBe('');
  });

  it('does not clear a status a member changed after the bot set its own', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    await setBufferingStatus(channel as never, TEXT);
    seeStatus('vc-1', 'Changed by a member');

    await clearBufferingStatus('vc-1');

    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a channel whose status it never set', async () => {
    seeStatus('vc-1', 'Movie night');

    await expect(clearBufferingStatus('vc-1')).resolves.toBeUndefined();
    expect(knownVoiceChannelStatus('vc-1')).toBe('Movie night');
  });
});

describe("recognising the bot's own status", () => {
  it('knows its text in every language and for any buffer length', () => {
    expect(isBotStatusText(TEXT)).toBe(true);
    expect(isBotStatusText(JA_TEXT)).toBe(true);
    expect(
      isBotStatusText(t('record.notice.channelStatus', 'ja', { minutes: 10 }))
    ).toBe(true);
    expect(
      isBotStatusText(t('record.notice.channelStatus', 'en', { minutes: 2 }))
    ).toBe(true);
  });

  it("does not claim a member's status, even one that quotes it", () => {
    expect(isBotStatusText('Movie night')).toBe(false);
    expect(isBotStatusText(`${TEXT}!`)).toBe(false);
    expect(isBotStatusText(`Re: ${JA_TEXT}`)).toBe(false);
    expect(isBotStatusText('')).toBe(false);
    expect(isBotStatusText(undefined)).toBe(false);
  });

  it('logs once whether GUILD_CREATE carries statuses at all', () => {
    resetVoiceChannelStatuses();
    vi.mocked(logger.info).mockClear();
    const guildCreate = (channels: object[]) =>
      observeGatewayPacket({ t: 'GUILD_CREATE', d: { channels } });

    guildCreate([{ id: 'text', type: ChannelType.GuildText }]);
    expect(logger.info).not.toHaveBeenCalled();
    guildCreate([
      { id: 'a', type: ChannelType.GuildVoice },
      { id: 'b', type: ChannelType.GuildVoice },
    ]);
    guildCreate([{ id: 'c', type: ChannelType.GuildVoice, status: null }]);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info).mock.calls[0][0]).toContain('0 of 2');
  });
});

describe('a status that outlives the bot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceChannelStatuses();
    waitUntilReady.mockResolvedValue(true);
    getConnection.mockReturnValue(undefined);
  });

  function client(
    options: { manageChannels?: boolean; canSetStatus?: boolean } = {}
  ) {
    const put = vi.fn(async () => undefined);
    const channel = {
      id: 'vc-1',
      type: ChannelType.GuildVoice,
      guild: { members: { me: { id: 'bot' } } },
      permissionsFor: () => ({
        has: (flag: bigint) =>
          (flag === SET_VOICE_CHANNEL_STATUS &&
            options.canSetStatus !== false) ||
          (flag === PermissionFlagsBits.ManageChannels &&
            options.manageChannels === true),
      }),
    };
    return {
      put,
      client: {
        rest: { put },
        channels: { cache: new Map([['vc-1', channel]]) },
      },
    };
  }

  it('takes over its own text left by an earlier run instead of skipping the channel', async () => {
    seeStatus('vc-1', TEXT);
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);
    // Already right: no request needed to show it.
    expect(put).not.toHaveBeenCalled();

    await clearBufferingStatus('vc-1');
    expect(put).toHaveBeenCalledWith('/channels/vc-1/voice-status', {
      body: { status: '' },
    });
  });

  it("rewrites its own text in the server's current language", async () => {
    seeStatus('vc-1', JA_TEXT);
    const { channel, put } = channelStub();

    await setBufferingStatus(channel as never, TEXT);

    expect(put).toHaveBeenCalledWith('/channels/vc-1/voice-status', {
      body: { status: TEXT },
    });
  });

  it('keeps a refused clear recognisable, and clears it on the next leave', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    await setBufferingStatus(channel as never, TEXT);
    put.mockRejectedValueOnce(new Error('Missing Permissions'));
    await clearBufferingStatus('vc-1');
    expect(knownVoiceChannelStatus('vc-1')).toBe(TEXT);

    // Next stay, as a reader only: nothing announces, but leaving clears it.
    const { client: discord, put: restPut } = client();
    await settleBufferingStatus('vc-1', discord as never);

    expect(restPut).toHaveBeenCalledWith('/channels/vc-1/voice-status', {
      body: { status: '' },
    });
    expect(knownVoiceChannelStatus('vc-1')).toBe('');
  });

  it('has nothing to wait for on a channel without its status', () => {
    seeStatus('vc-1', 'Movie night');
    const { client: discord } = client();

    expect(settleBufferingStatus('vc-1', discord as never)).toBeUndefined();
    expect(settleBufferingStatus('vc-2', discord as never)).toBeUndefined();
  });

  it('waits for a clear that is already running instead of starting another', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    await setBufferingStatus(channel as never, TEXT);
    const { client: discord } = client();

    const first = clearBufferingStatus('vc-1');
    const settled = settleBufferingStatus('vc-1', discord as never);

    expect(settled).toBe(first);
    await settled;
    expect(put).toHaveBeenCalledTimes(2); // set, then one clear
  });

  it('clears after a set that was still in flight, instead of leaving it behind', async () => {
    seeStatus('vc-1', null);
    const { channel, put } = channelStub();
    let landSet!: () => void;
    put.mockImplementationOnce(
      () =>
        new Promise<undefined>(
          (resolve) => (landSet = () => resolve(undefined))
        )
    );

    const setting = setBufferingStatus(channel as never, TEXT);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const clearing = clearBufferingStatus('vc-1');
    landSet();
    await Promise.all([setting, clearing]);

    expect(put).toHaveBeenLastCalledWith('/channels/vc-1/voice-status', {
      body: { status: '' },
    });
    expect(knownVoiceChannelStatus('vc-1')).toBe('');
  });

  it('clears leftovers at startup where the bot has Manage Channels', async () => {
    seeStatus('vc-1', TEXT);
    const { client: discord, put } = client({ manageChannels: true });

    await expect(clearStaleBufferingStatuses(discord as never)).resolves.toBe(
      1
    );

    expect(put).toHaveBeenCalledWith('/channels/vc-1/voice-status', {
      body: { status: '' },
    });
  });

  it.each([
    ['without Manage Channels', { manageChannels: false }, undefined],
    [
      'without the status permission',
      { manageChannels: true, canSetStatus: false },
      undefined,
    ],
    ['while connected there', { manageChannels: true }, { channelId: 'vc-1' }],
  ])(
    'leaves a leftover for the next stay %s',
    async (_label, options, connection) => {
      seeStatus('vc-1', TEXT);
      getConnection.mockReturnValue(connection);
      const { client: discord, put } = client(options);

      await expect(clearStaleBufferingStatuses(discord as never)).resolves.toBe(
        0
      );

      expect(put).not.toHaveBeenCalled();
    }
  );

  it("never clears a member's status at startup", async () => {
    seeStatus('vc-1', 'Movie night');
    const { client: discord, put } = client({ manageChannels: true });

    await clearStaleBufferingStatuses(discord as never);

    expect(put).not.toHaveBeenCalled();
  });
});
