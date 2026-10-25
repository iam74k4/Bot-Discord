import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A connection made only to read chat aloud keeps no audio, so `/voice status`
 * must not tell people their channel is being buffered because of it.
 *
 * The status panel's own output is covered in status.test.ts; this pins the
 * predicate it relies on, so a text-to-speech join can never be mistaken
 * for one that keeps audio.
 */
const getConnection = vi.hoisted(() => vi.fn());
const getConnectedChannelInGuild = vi.hoisted(() => vi.fn());

vi.mock('../recording/connectionManager.js', () => ({
  connectionManager: {
    getConnection,
    getConnectedChannelInGuild,
    isAtLimit: vi.fn(() => false),
  },
}));

const isChannelExcluded = vi.hoisted(() => vi.fn(() => false));

vi.mock('../repositories/voiceSettingsRepository.js', () => ({
  voiceSettingsRepository: {
    isAutoJoinEnabled: vi.fn(() => true),
    isChannelExcluded,
  },
}));

const { isBuffering, diagnoseBufferingGap, describeBufferingGap } =
  await import('../application/diagnose.js');
const { t } = await import('../../../locales/index.js');

const GUILD = 'guild-1';
const VC = 'vc-1';

describe('/voice status with text-to-speech connections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isChannelExcluded.mockReturnValue(false);
  });

  const guild = { id: GUILD, members: { me: null } };
  const channel = { id: VC, permissionsFor: vi.fn(() => null) };

  it('does not count a text-to-speech-only connection as buffering', () => {
    getConnection.mockReturnValue({ channelId: VC, receiving: false });

    expect(isBuffering(VC)).toBe(false);
    expect(getConnection).toHaveBeenCalledWith(VC);
  });

  it.each([
    ['a receiving connection', { channelId: VC, receiving: true }],
    ['a connection without the flag', { channelId: VC }],
  ])('counts %s as buffering', (_label, connection) => {
    getConnection.mockReturnValue(connection);

    expect(isBuffering(VC)).toBe(true);
  });

  it('counts nothing as buffering without a connection', () => {
    getConnection.mockReturnValue(undefined);

    expect(isBuffering(VC)).toBe(false);
  });

  it('explains a text-to-speech-only connection as reading aloud, not as missing', () => {
    getConnectedChannelInGuild.mockReturnValue(VC);

    expect(
      diagnoseBufferingGap(guild as never, channel as never)
    ).toStrictEqual({ reason: 'readOnly' });
  });

  it.each<'en' | 'ja'>(['en', 'ja'])(
    'says a text-to-speech-only connection is only reading (%s)',
    (locale) => {
      getConnection.mockReturnValue({ channelId: VC, receiving: false });
      getConnectedChannelInGuild.mockReturnValue(VC);

      expect(isBuffering(VC)).toBe(false);
      // Not "buffered", and not "the bot has not joined" either.
      expect(
        describeBufferingGap(
          diagnoseBufferingGap(guild as never, channel as never),
          VC,
          locale
        )
      ).toBe(t('record.notBuffered.readOnly', locale, { channel: VC }));
    }
  );

  it('still reports an excluded channel as excluded', () => {
    isChannelExcluded.mockReturnValue(true);
    getConnection.mockReturnValue({ channelId: VC, receiving: false });
    getConnectedChannelInGuild.mockReturnValue(VC);

    expect(
      diagnoseBufferingGap(guild as never, channel as never)
    ).toStrictEqual({ reason: 'excluded' });
  });
});
