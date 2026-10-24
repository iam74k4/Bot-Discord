import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deleteOldLogs = vi.fn(() => 2);
const loggerInfo = vi.fn();

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
  },
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
});
