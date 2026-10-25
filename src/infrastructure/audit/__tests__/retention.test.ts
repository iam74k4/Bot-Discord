import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteOldLogs = vi.fn(() => 2);
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

const DAY = 24 * 60 * 60 * 1000;

vi.mock('../auditRepository.js', () => ({
  auditRepository: {
    deleteOldLogs,
  },
}));

vi.mock('../../../config/index.js', () => ({
  env: {
    AUDIT_LOG_RETENTION_DAYS: 90,
  },
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
  },
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

describe('audit log retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs cleanup immediately and avoids duplicate intervals', async () => {
    const { startAuditRetention, stopAuditRetention } =
      await import('../retention.js');

    startAuditRetention();
    startAuditRetention();

    expect(deleteOldLogs).toHaveBeenCalledTimes(1);
    expect(deleteOldLogs).toHaveBeenCalledWith(90);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(deleteOldLogs).toHaveBeenCalledTimes(2);

    stopAuditRetention();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(deleteOldLogs).toHaveBeenCalledTimes(2);
  });

  it('logs how many entries a purge removed', async () => {
    const { startAuditRetention, stopAuditRetention } =
      await import('../retention.js');

    startAuditRetention();

    expect(loggerInfo).toHaveBeenCalledWith('Cleaned up 2 old audit log(s)');

    stopAuditRetention();
  });

  it('stays quiet when nothing was old enough to purge', async () => {
    deleteOldLogs.mockReturnValueOnce(0);
    const { startAuditRetention, stopAuditRetention } =
      await import('../retention.js');

    startAuditRetention();

    expect(deleteOldLogs).toHaveBeenCalledTimes(1);
    expect(loggerInfo).not.toHaveBeenCalled();

    stopAuditRetention();
  });

  it('can be restarted after a stop', async () => {
    const { startAuditRetention, stopAuditRetention } =
      await import('../retention.js');

    startAuditRetention();
    stopAuditRetention();
    startAuditRetention();

    expect(deleteOldLogs).toHaveBeenCalledTimes(2);

    stopAuditRetention();
  });

  it('purges once a day, every day, while running', async () => {
    const { startAuditRetention, stopAuditRetention } =
      await import('../retention.js');

    startAuditRetention();
    vi.advanceTimersByTime(DAY - 1);
    expect(deleteOldLogs).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(deleteOldLogs).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(2 * DAY);
    expect(deleteOldLogs).toHaveBeenCalledTimes(4);
    expect(deleteOldLogs).toHaveBeenNthCalledWith(4, 90);

    stopAuditRetention();
  });

  it('ignores a stop when it was never started', async () => {
    const { stopAuditRetention } = await import('../retention.js');

    expect(() => stopAuditRetention()).not.toThrow();
    vi.advanceTimersByTime(DAY);
    expect(deleteOldLogs).not.toHaveBeenCalled();
  });

  /**
   * Regression: a failed purge used to throw out of startAuditRetention()
   * (aborting app start) on the first run, and from setInterval into the
   * uncaughtException handler on later ticks, shutting the bot down. A purge
   * is housekeeping: it is logged and retried the next day.
   */
  describe('when a purge fails', () => {
    function loggedProblems(): unknown[][] {
      return [...loggerError.mock.calls, ...loggerWarn.mock.calls];
    }

    it('logs a failed first purge instead of throwing out of start', async () => {
      deleteOldLogs.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const { startAuditRetention, stopAuditRetention } =
        await import('../retention.js');

      try {
        expect(() => startAuditRetention()).not.toThrow();
        expect(loggedProblems()).not.toHaveLength(0);

        // The schedule still runs the next day.
        vi.advanceTimersByTime(DAY);
        expect(deleteOldLogs).toHaveBeenCalledTimes(2);
      } finally {
        stopAuditRetention();
      }
    });

    it('keeps the daily schedule alive when a later purge fails', async () => {
      const { startAuditRetention, stopAuditRetention } =
        await import('../retention.js');
      startAuditRetention();
      deleteOldLogs.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });

      try {
        expect(() => vi.advanceTimersByTime(DAY)).not.toThrow();
        expect(loggedProblems()).not.toHaveLength(0);

        vi.advanceTimersByTime(DAY);
        expect(deleteOldLogs).toHaveBeenCalledTimes(3);
      } finally {
        stopAuditRetention();
      }
    });
  });
});
