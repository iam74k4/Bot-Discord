import {
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A connection made only to read chat aloud keeps no audio, so `/voice status`
 * must not tell people their channel is being buffered because of it.
 */
const getConnection = vi.hoisted(() => vi.fn());

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection,
    getConnectionCount: vi.fn(() => 1),
  },
}));

const isChannelExcluded = vi.hoisted(() => vi.fn(() => false));

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: {
    isAutoJoinEnabled: vi.fn(() => true),
    listExclusions: vi.fn(() => []),
    isChannelExcluded,
  },
}));

vi.mock('../../../locales/guildLocale.js', () => ({
  resolveLocale: (interaction: { locale: string }) =>
    interaction.locale === 'ja' ? 'ja' : 'en',
}));

vi.mock('../../../config/index.js', () => ({
  env: { MAX_CONCURRENT_VC_CONNECTIONS: 3, AUDIO_BUFFER_DURATION: 600 },
}));

const { executeStatusCommand } = await import('../application/status.js');
const { t } = await import('../../../locales/index.js');

const VC = 'vc-1';

function interaction(locale = 'en-US') {
  return {
    guildId: 'guild-1',
    locale,
    member: { voice: { channelId: VC } },
    reply: vi.fn(async () => undefined),
  };
}

function currentChannelLine(
  fake: ReturnType<typeof interaction>,
  locale: 'en' | 'ja' = 'en'
): string {
  expect(fake.reply).toHaveBeenCalledTimes(1);
  const [payload] = fake.reply.mock.calls[0] as unknown as [
    { embeds: EmbedBuilder[]; flags: number },
  ];
  expect(payload.flags).toBe(MessageFlags.Ephemeral);
  const description = payload.embeds[0].toJSON().description ?? '';
  const prefix = `${t('record.statusHint', locale)}\n\n`;
  expect(description.startsWith(prefix)).toBe(true);
  return description.slice(prefix.length);
}

const run = (fake: ReturnType<typeof interaction>) =>
  executeStatusCommand(fake as unknown as ChatInputCommandInteraction);

describe('/voice status with text-to-speech connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isChannelExcluded.mockReturnValue(false);
  });

  it.each<'en' | 'ja'>(['en', 'ja'])(
    'says a text-to-speech-only connection is only reading (%s)',
    async (locale) => {
      getConnection.mockReturnValue({ channelId: VC, receiving: false });
      const fake = interaction(locale);

      await run(fake);

      expect(getConnection).toHaveBeenCalledWith(VC);
      // Not "buffered", and not "you are not in a voice channel" either.
      expect(currentChannelLine(fake, locale)).toBe(
        t('record.autojoin.currentChannelReadingOnly', locale)
      );
    }
  );

  it.each([
    ['a receiving connection', { channelId: VC, receiving: true }],
    ['a connection without the flag', { channelId: VC }],
  ])('reports %s as buffering', async (_label, connection) => {
    getConnection.mockReturnValue(connection);
    const fake = interaction();

    await run(fake);

    expect(currentChannelLine(fake)).toBe(
      t('record.autojoin.currentChannelBuffered', 'en')
    );
  });

  it('reports nothing kept when there is no connection', async () => {
    getConnection.mockReturnValue(undefined);
    const fake = interaction();

    await run(fake);

    expect(currentChannelLine(fake)).toBe(
      t('record.autojoin.currentChannelNotKept', 'en')
    );
  });

  it('still reports an excluded channel as excluded', async () => {
    isChannelExcluded.mockReturnValue(true);
    getConnection.mockReturnValue({ channelId: VC, receiving: false });
    const fake = interaction('ja');

    await run(fake);

    expect(currentChannelLine(fake, 'ja')).toBe(
      t('record.autojoin.currentChannelExcluded', 'ja')
    );
  });
});
