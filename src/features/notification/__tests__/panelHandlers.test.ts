import { beforeEach, describe, expect, it, vi } from 'vitest';

const showNotificationPanel = vi.fn();

vi.mock('../application/panel.js', () => ({
  showNotificationPanel,
}));

describe('notification panel handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes status to the notification panel status view', async () => {
    const { handleStatus } = await import('../application/notification.js');

    const interaction = {
      locale: 'en-US',
    } as never;

    await handleStatus(interaction);

    expect(showNotificationPanel).toHaveBeenCalledWith(interaction, 'en', {
      initialView: 'status',
    });
  });

  it('routes stats to the notification panel stats view', async () => {
    const { handleStats } = await import('../application/stats.js');

    const interaction = {
      locale: 'ja',
      options: {
        getString: vi.fn().mockReturnValue('week'),
      },
    } as never;

    await handleStats(interaction);

    expect(showNotificationPanel).toHaveBeenCalledWith(interaction, 'ja', {
      initialView: 'stats',
      initialPeriod: 'week',
    });
  });

  it('defaults stats to all time when no period is chosen', async () => {
    const { handleStats } = await import('../application/stats.js');

    const interaction = {
      locale: 'en-US',
      options: {
        getString: vi.fn().mockReturnValue(null),
      },
    } as never;

    await handleStats(interaction);

    expect(showNotificationPanel).toHaveBeenCalledWith(interaction, 'en', {
      initialView: 'stats',
      initialPeriod: 'all',
    });
  });
});
