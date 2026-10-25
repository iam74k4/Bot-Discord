import { ButtonStyle, ComponentType, PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const resolveBackgroundLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveBackgroundLocale }));

const setBufferingStatus = vi.hoisted(() => vi.fn());
const clearBufferingStatus = vi.hoisted(() => vi.fn());
vi.mock('../application/voiceChannelStatus.js', () => ({
  setBufferingStatus,
  clearBufferingStatus,
}));

vi.mock('../../../config/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../config/index.js')
  >('../../../config/index.js');
  return {
    ...actual,
    env: {
      ...actual.env,
      AUDIO_BUFFER_DURATION: 300,
      RECORDING_RETENTION_HOURS: 24,
    },
  };
});

const {
  announceBuffering,
  buildOptedOutNoticeEmbed,
  forgetAnnouncement,
  getAnnouncementProblem,
} = await import('../application/announce.js');
const { t } = await import('../../../locales/index.js');
const { logger } = await import('../../../shared/utils/logger.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');

type SentPayload = {
  embeds: Array<{
    data: { title?: string; description?: string; color?: number };
  }>;
  components: Array<{
    toJSON(): {
      components: Array<{
        type: ComponentType;
        custom_id?: string;
        style?: ButtonStyle;
        label?: string;
      }>;
    };
  }>;
};

let nextMessageId = 0;

function channelStub(
  options: { canSend?: boolean; send?: ReturnType<typeof vi.fn> } = {},
  id = 'voice-1'
) {
  const canSend = options.canSend ?? true;
  return {
    id,
    guild: {
      id: 'guild-1',
      preferredLocale: 'en-US',
      members: { me: { id: 'bot-1' } },
    },
    permissionsFor: vi.fn().mockReturnValue({
      has: (flag: bigint) =>
        canSend ||
        (flag !== PermissionFlagsBits.SendMessages &&
          flag !== PermissionFlagsBits.ViewChannel),
    }),
    isTextBased: () => true,
    send:
      options.send ?? vi.fn(async () => ({ id: `message-${++nextMessageId}` })),
    messages: { delete: vi.fn(async () => undefined) },
  };
}

function sentPayload(send: ReturnType<typeof vi.fn>, call = 0): SentPayload {
  return send.mock.calls[call][0] as SentPayload;
}

function expectedDescription(locale: 'en' | 'ja') {
  return `${t('record.notice.body', locale, {
    minutes: 5,
    hours: 24,
    command: '`/voice record`',
  })}\n\n${t('record.notice.optOut', locale, {
    command: '`/voice autojoin disable`',
  })}`;
}

describe('announceBuffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBackgroundLocale.mockReturnValue('en');
    setBufferingStatus.mockResolvedValue(undefined);
    clearBufferingStatus.mockResolvedValue(undefined);
    forgetAnnouncement('voice-1');
    forgetAnnouncement('voice-2');
    clearBufferingStatus.mockClear();
  });

  it('posts how long audio is kept, who can save it and when it is deleted', async () => {
    const channel = channelStub();
    await announceBuffering(channel as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
    const payload = sentPayload(channel.send);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].data.title).toBe(t('record.notice.title', 'en'));
    // AUDIO_BUFFER_DURATION is 300s in this file: a 5 minute window.
    expect(payload.embeds[0].data.description).toBe(expectedDescription('en'));
    expect(payload.embeds[0].data.color).toBe(COLORS.WARNING);
  });

  it('carries a one-tap opt-out button for this channel', async () => {
    const channel = channelStub();
    await announceBuffering(channel as never);

    const [button] = sentPayload(channel.send).components[0].toJSON()
      .components;
    expect(button.type).toBe(ComponentType.Button);
    expect(button.custom_id).toBe('voice-optout:voice-1');
    expect(button.style).toBe(ButtonStyle.Secondary);
    expect(button.label).toBe(t('record.notice.optOutButton', 'en'));
  });

  it('writes the notice in the server language, not the reader language', async () => {
    resolveBackgroundLocale.mockReturnValue('ja');
    const channel = channelStub();

    await announceBuffering(channel as never);

    expect(resolveBackgroundLocale).toHaveBeenCalledWith(channel.guild);
    const embed = sentPayload(channel.send).embeds[0].data;
    expect(embed.title).toBe(t('record.notice.title', 'ja'));
    expect(embed.description).toBe(expectedDescription('ja'));
  });

  it('also shows it in the voice channel status', async () => {
    const channel = channelStub();

    await announceBuffering(channel as never);

    expect(setBufferingStatus).toHaveBeenCalledWith(
      channel,
      t('record.notice.channelStatus', 'en', { minutes: 5 })
    );
  });

  it('takes the status down again when the bot leaves', () => {
    forgetAnnouncement('voice-1');

    expect(clearBufferingStatus).toHaveBeenCalledWith('voice-1');
  });

  it('announces once per stay, not on every event', async () => {
    const channel = channelStub();

    await announceBuffering(channel as never);
    await announceBuffering(channel as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('replaces the previous notice instead of stacking a new one each stay', async () => {
    // A channel no other test posted in, so there is no older notice.
    const channel = channelStub({}, 'voice-fresh');

    await announceBuffering(channel as never);
    forgetAnnouncement('voice-fresh');
    await announceBuffering(channel as never);

    expect(channel.send).toHaveBeenCalledTimes(2);
    const firstId = (await channel.send.mock.results[0].value) as {
      id: string;
    };
    expect(channel.messages.delete).toHaveBeenCalledTimes(1);
    expect(channel.messages.delete).toHaveBeenCalledWith(firstId.id);
    // The old one is removed before the new one goes out.
    expect(channel.messages.delete.mock.invocationCallOrder[0]).toBeLessThan(
      channel.send.mock.invocationCallOrder[1]
    );
  });

  it('still posts when the previous notice was already deleted', async () => {
    const channel = channelStub();
    await announceBuffering(channel as never);
    forgetAnnouncement('voice-1');
    channel.messages.delete.mockRejectedValueOnce(new Error('Unknown Message'));

    await announceBuffering(channel as never);

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(getAnnouncementProblem('voice-1')).toBeUndefined();
  });

  it('remembers that it could not post, for /voice status', async () => {
    const channel = channelStub({ canSend: false });

    await announceBuffering(channel as never);

    expect(channel.send).not.toHaveBeenCalled();
    expect(getAnnouncementProblem('voice-1')).toBe('noPermission');
  });

  it('tracks announcements per channel', async () => {
    const first = channelStub({}, 'voice-1');
    const second = channelStub({}, 'voice-2');

    await announceBuffering(first as never);
    await announceBuffering(second as never);

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    ['SendMessages', PermissionFlagsBits.SendMessages],
  ])('stays quiet when only %s is missing', async (_label, missing) => {
    const channel = channelStub();
    channel.permissionsFor.mockReturnValue({
      has: (flag: bigint) => flag !== missing,
    });

    await announceBuffering(channel as never);

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('stays quiet when permissions cannot be resolved', async () => {
    const channel = channelStub();
    channel.permissionsFor.mockReturnValue(null);

    await announceBuffering(channel as never);

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('stays quiet when the bot member is not cached', async () => {
    const channel = channelStub();
    (channel.guild.members as { me: unknown }).me = null;

    await expect(announceBuffering(channel as never)).resolves.toBeUndefined();

    expect(channel.permissionsFor).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    // An uncached member is an expected state, not a failed announcement.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet in a voice channel without a text chat', async () => {
    const channel = { ...channelStub(), isTextBased: () => false };

    await announceBuffering(channel as never);

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('never throws back into the voice connection path', async () => {
    const send = vi.fn().mockRejectedValue(new Error('rate limited'));

    await expect(
      announceBuffering(channelStub({ send }) as never)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to announce buffering in voice-1')
    );
    expect(getAnnouncementProblem('voice-1')).toBe('sendFailed');
  });

  it('posts once when two joins race for the same channel', async () => {
    const pendingSends: Array<() => void> = [];
    const send = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) =>
          pendingSends.push(() => resolve({ id: 'm' }))
        )
    );
    const channel = channelStub({ send });

    // The second call arrives while the first send is still in flight.
    const first = announceBuffering(channel as never);
    const second = announceBuffering(channel as never);
    await Promise.resolve();
    pendingSends.forEach((finish) => finish());
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tries again on the next announcement after a failed send, then clears the problem', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({ id: 'm' });
    const channel = channelStub({ send });

    await announceBuffering(channel as never);
    await announceBuffering(channel as never);

    expect(send).toHaveBeenCalledTimes(2);
    expect(getAnnouncementProblem('voice-1')).toBeUndefined();
  });

  it('posts once a missing permission is granted', async () => {
    const channel = channelStub();
    channel.permissionsFor.mockReturnValue({ has: () => false });

    await announceBuffering(channel as never);
    channel.permissionsFor.mockReturnValue({ has: () => true });
    await announceBuffering(channel as never);

    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});

describe('buildOptedOutNoticeEmbed', () => {
  it('keeps the explanation and says who excluded the channel', () => {
    const embed = buildOptedOutNoticeEmbed('en', {
      channelId: 'voice-1',
      userId: 'admin-1',
      left: true,
    }).toJSON();

    expect(embed.title).toBe(t('record.notice.title', 'en'));
    expect(embed.color).toBe(COLORS.INFO);
    expect(embed.description).toContain(
      t('record.notice.optedOut', 'en', {
        channel: 'voice-1',
        user: '<@admin-1>',
      })
    );
    expect(embed.description).toContain(t('record.notice.optedOutLeft', 'en'));
    expect(embed.description).not.toContain(
      t('record.notice.optOutButton', 'en')
    );
  });

  it('does not claim the bot left when it was not there', () => {
    const embed = buildOptedOutNoticeEmbed('ja', {
      channelId: 'voice-1',
      userId: 'admin-1',
      left: false,
    }).toJSON();

    expect(embed.description).not.toContain(
      t('record.notice.optedOutLeft', 'ja')
    );
  });
});
