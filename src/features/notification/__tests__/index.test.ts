import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const closeAllStaleSessions = vi.fn();
const reconcileActiveVoiceSessions = vi.fn();
const endAllSessions = vi.fn();
const cleanupOldSessions = vi.fn(() => 3);
const loggerInfo = vi.fn();

vi.mock('../tracking/voiceTracker.js', () => ({
  voiceTracker: {
    closeAllStaleSessions,
    reconcileActiveVoiceSessions,
    endAllSessions,
  },
}));

vi.mock('../repositories/voiceSessionRepository.js', () => ({
  voiceSessionRepository: {
    cleanupOldSessions,
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    info: loggerInfo,
    warn: vi.fn(),
  },
  getErrorMessage: (e: unknown) => String(e),
}));

vi.mock('../repositories/notificationChannelRepository.js', () => ({
  notificationChannelRepository: {
    getEnabled: (_guildId: string, type: string) =>
      type === 'voice' ? 'vc-log' : null,
  },
}));

describe('notification feature lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs voice session cleanup immediately and avoids duplicate intervals', async () => {
    const { start, stop } = await import('../index.js');
    const client = {} as never;
    // Retention comes from the context the feature is started with.
    const context = {
      client,
      config: { VOICE_SESSION_RETENTION_DAYS: 30 },
    } as never;

    start(context);
    start(context);

    expect(closeAllStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileActiveVoiceSessions).toHaveBeenCalledTimes(1);
    expect(reconcileActiveVoiceSessions).toHaveBeenCalledWith(client);
    expect(cleanupOldSessions).toHaveBeenCalledTimes(1);
    expect(cleanupOldSessions).toHaveBeenCalledWith(30);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(cleanupOldSessions).toHaveBeenCalledTimes(2);

    stop();
    expect(endAllSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(cleanupOldSessions).toHaveBeenCalledTimes(2);
  });

  it('keys stats days by the configured time zone', async () => {
    const { start, stop } = await import('../index.js');
    const { getStatsTimeZone } = await import('../stats/calendar.js');

    start({
      client: {},
      config: {
        VOICE_SESSION_RETENTION_DAYS: 30,
        STATS_TIMEZONE: 'Europe/London',
      },
    } as never);

    expect(getStatsTimeZone()).toBe('Europe/London');
    stop();
  });

  it('adds its settings to the admin overview only while started', async () => {
    const { start, stop } = await import('../index.js');
    const { collectSettingsSummaries } =
      await import('../../../shared/settingsSummary/index.js');
    const { t } = await import('../../../locales/index.js');
    const { commandMention } =
      await import('../../../shared/utils/commandMentions.js');
    const context = { guildId: 'guild-1', locale: 'en' } as const;

    start({
      client: {},
      config: { VOICE_SESSION_RETENTION_DAYS: 30 },
    } as never);

    const fields = await collectSettingsSummaries(context);
    expect(fields.map((f) => f.name)).toEqual([
      t('notification.summary.voice', 'en'),
      t('notification.summary.welcome', 'en'),
    ]);
    expect(fields[0].value).toBe('<#vc-log>');
    // Unset reads as a setup hint, not a blank.
    expect(fields[1].value).toBe(
      t('common.notSetWithHint', 'en', {
        command: commandMention('notification welcome set'),
      })
    );

    stop();
    expect(await collectSettingsSummaries(context)).toEqual([]);
  });
});
