import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const { startDailyCleanup, stopCleanupInterval } =
  await import('../cleanup.js');

describe('cleanup utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the cleanup immediately and then daily', () => {
    const task = vi.fn();

    const interval = startDailyCleanup(task);

    expect(task).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(task).toHaveBeenCalledTimes(2);

    stopCleanupInterval(interval);
  });

  it('logs a failed first run instead of throwing, and runs again tomorrow', () => {
    const task = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('database is locked');
      })
      .mockImplementation(() => undefined);

    const interval = startDailyCleanup(task, 'Audit log retention');

    expect(logger.error).toHaveBeenCalledWith(
      'Audit log retention failed; it will run again in 24 hours:',
      'database is locked'
    );
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(task).toHaveBeenCalledTimes(2);

    stopCleanupInterval(interval);
  });

  it('keeps the schedule alive when a later run throws', () => {
    const task = vi.fn();
    const interval = startDailyCleanup(task);
    task.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    expect(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000)).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      'Daily cleanup failed; it will run again in 24 hours:',
      'disk I/O error'
    );
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(task).toHaveBeenCalledTimes(3);

    stopCleanupInterval(interval);
  });

  it('stops the interval safely', () => {
    const task = vi.fn();

    const interval = startDailyCleanup(task);
    const stopped = stopCleanupInterval(interval);

    expect(stopped).toBeNull();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
