import type { App } from './composition.js';
import { getErrorMessage, logger } from '../shared/utils/logger.js';
import { sendAlert } from '../shared/utils/alert.js';

/**
 * Signals and last-resort error handling for the process.
 *
 * Kept out of `src/index.ts` (which runs on import) so the exit codes can be
 * tested: they decide whether the host restarts the bot. Railway's
 * ON_FAILURE policy only restarts on a non-zero exit, so a crash must never
 * exit 0.
 */

/** The parts of `process` used here, injectable for tests. */
export interface ProcessHooks {
  on(event: string, listener: (...args: unknown[]) => void): void;
  exit(code: number): void;
}

const nodeProcess: ProcessHooks = {
  on: (event, listener) => {
    process.on(event, listener);
  },
  exit: (code) => process.exit(code),
};

function reportAlert(title: string, message: string, stack?: string): void {
  sendAlert(
    title,
    message,
    stack ? [{ name: 'Stack', value: stack.slice(0, 1000) }] : undefined
  ).catch((error: unknown) => {
    logger.error(`Failed to send alert for ${title}:`, getErrorMessage(error));
  });
}

export function installProcessHandlers(
  app: App,
  shutdownTimeoutMs: number,
  hooks: ProcessHooks = nodeProcess
): { gracefulShutdown(signal: string, exitCode?: number): Promise<void> } {
  let isShuttingDown = false;

  async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
    if (isShuttingDown) {
      logger.warn(`Shutdown already in progress, ignoring ${signal}`);
      return;
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
      logger.error('Shutdown timed out, forcing exit');
      hooks.exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();

    await app.stop();

    clearTimeout(forceExitTimer);
    logger.info('Graceful shutdown complete');
    hooks.exit(exitCode);
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    hooks.on(signal, () => void gracefulShutdown(signal));
  }

  hooks.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection at:', promise, 'reason:', reason);
    reportAlert(
      'Unhandled Promise Rejection',
      getErrorMessage(reason ?? 'Unknown'),
      reason instanceof Error ? reason.stack : undefined
    );
  });

  hooks.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    reportAlert(
      'Uncaught Exception',
      getErrorMessage(error),
      error instanceof Error ? error.stack : undefined
    );

    // Exit non-zero so the host's restart-on-failure policy brings it back.
    void gracefulShutdown('uncaughtException', 1).catch((e: unknown) => {
      logger.error('Shutdown failed after uncaughtException:', e);
      hooks.exit(1);
    });
  });

  app.client.on('error', (error) => {
    logger.error('Discord client error:', error);
    reportAlert('Discord Client Error', getErrorMessage(error));
  });

  return { gracefulShutdown };
}
