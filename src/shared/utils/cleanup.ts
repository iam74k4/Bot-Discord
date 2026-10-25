import { getErrorMessage, logger } from './logger.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Run `task` now and then once a day.
 *
 * A run that throws is logged and retried on the next tick. These jobs are
 * housekeeping: an exception escaping the first run would abort startup, and
 * one escaping a later tick would reach the process's uncaughtException
 * handler and shut the bot down over a transient "database is locked".
 */
export function startDailyCleanup(
  task: () => void,
  name = 'Daily cleanup'
): NodeJS.Timeout {
  const run = (): void => {
    try {
      task();
    } catch (error) {
      logger.error(
        `${name} failed; it will run again in 24 hours:`,
        getErrorMessage(error)
      );
    }
  };

  run();
  return setInterval(run, ONE_DAY_MS);
}

export function stopCleanupInterval(
  interval: NodeJS.Timeout | null
): NodeJS.Timeout | null {
  if (interval) {
    clearInterval(interval);
  }

  return null;
}
