import { PermissionFlagsBits } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

const resolveGuildLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveGuildLocale }));

vi.mock('../../../config/index.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../config/index.js')
  >('../../../config/index.js');
  return { ...actual, env: { ...actual.env, AUDIO_BUFFER_DURATION: 300 } };
});

const { announceBuffering, forgetAnnouncement } =
  await import('../application/announce.js');
const { t } = await import('../../../locales/index.js');
const { logger } = await import('../../../shared/utils/logger.js');
const { COLORS } = await import('../../../shared/utils/constants/index.js');

type SentPayload = {
  embeds: Array<{
    data: { title?: string; description?: string; color?: number };
  }>;
};

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
    send: options.send ?? vi.fn().mockResolvedValue({}),
  };
}

describe('announceBuffering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveGuildLocale.mockReturnValue('en');
    forgetAnnouncement('voice-1');
    forgetAnnouncement('voice-2');
  });

  it('posts the buffer window into the voice channel chat', async () => {
    const send = vi.fn().mockResolvedValue({});
    await announceBuffering(channelStub({ send }) as never);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as SentPayload;
    expect(payload.embeds).toHaveLength(1);
    // AUDIO_BUFFER_DURATION is 300s in this file: a 5 minute window.
    expect(payload.embeds[0].data.description).toBe(
      `${t('record.notice.body', 'en', { minutes: 5 })}\n\n${t(
        'record.notice.optOut',
        'en'
      )}`
    );
  });

  it('announces once per stay, not on every event', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });

    await announceBuffering(channel as never);
    await announceBuffering(channel as never);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('announces again after the bot leaves and returns', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });

    await announceBuffering(channel as never);
    forgetAnnouncement('voice-1');
    await announceBuffering(channel as never);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when it cannot post in the channel', async () => {
    const send = vi.fn().mockResolvedValue({});
    await announceBuffering(channelStub({ canSend: false, send }) as never);

    expect(send).not.toHaveBeenCalled();
  });

  it('builds the notice from the guild locale', async () => {
    resolveGuildLocale.mockReturnValue('ja');
    const send = vi.fn().mockResolvedValue({});

    await announceBuffering(channelStub({ send }) as never);

    // The Discord preferred locale is the fallback for the guild setting.
    expect(resolveGuildLocale).toHaveBeenCalledWith('guild-1', 'en');
    const embed = (send.mock.calls[0][0] as SentPayload).embeds[0].data;
    expect(embed.title).toBe(t('record.notice.title', 'ja'));
    expect(embed.description).toBe(
      `${t('record.notice.body', 'ja', { minutes: 5 })}\n\n${t(
        'record.notice.optOut',
        'ja'
      )}`
    );
    expect(embed.color).toBe(COLORS.WARNING);
  });

  it('tracks announcements per channel', async () => {
    const send = vi.fn().mockResolvedValue({});

    await announceBuffering(channelStub({ send }, 'voice-1') as never);
    await announceBuffering(channelStub({ send }, 'voice-2') as never);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    ['SendMessages', PermissionFlagsBits.SendMessages],
  ])('stays quiet when only %s is missing', async (_label, missing) => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });
    channel.permissionsFor.mockReturnValue({
      has: (flag: bigint) => flag !== missing,
    });

    await announceBuffering(channel as never);

    expect(send).not.toHaveBeenCalled();
  });

  it('stays quiet when permissions cannot be resolved', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });
    channel.permissionsFor.mockReturnValue(null);

    await announceBuffering(channel as never);

    expect(send).not.toHaveBeenCalled();
  });

  it('stays quiet when the bot member is not cached', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });
    (channel.guild.members as { me: unknown }).me = null;

    await expect(announceBuffering(channel as never)).resolves.toBeUndefined();

    expect(channel.permissionsFor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // An uncached member is an expected state, not a failed announcement.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet in a voice channel without a text chat', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = { ...channelStub({ send }), isTextBased: () => false };

    await announceBuffering(channel as never);

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws back into the voice connection path', async () => {
    const send = vi.fn().mockRejectedValue(new Error('rate limited'));

    await expect(
      announceBuffering(channelStub({ send }) as never)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to announce buffering in voice-1')
    );
  });

  it('posts once when two joins race for the same channel', async () => {
    const pendingSends: Array<() => void> = [];
    const send = vi.fn(
      () => new Promise<void>((resolve) => pendingSends.push(resolve))
    );
    const channel = channelStub({ send });

    // The second call arrives while the first send is still in flight.
    const first = announceBuffering(channel as never);
    const second = announceBuffering(channel as never);
    pendingSends.forEach((finish) => finish());
    await Promise.all([first, second]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('makes one best-effort attempt per stay: a failed send is not retried until the bot leaves', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({});
    const channel = channelStub({ send });

    await announceBuffering(channel as never);
    await announceBuffering(channel as never);
    expect(send).toHaveBeenCalledTimes(1);

    forgetAnnouncement('voice-1');
    await announceBuffering(channel as never);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not retry within a stay after a missing permission is granted', async () => {
    const send = vi.fn().mockResolvedValue({});
    const channel = channelStub({ send });
    channel.permissionsFor.mockReturnValue({ has: () => false });

    await announceBuffering(channel as never);
    channel.permissionsFor.mockReturnValue({ has: () => true });
    await announceBuffering(channel as never);

    expect(send).not.toHaveBeenCalled();
  });
});
