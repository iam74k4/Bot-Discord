import { createApp } from './app/composition.js';
import { installProcessHandlers } from './app/processHandlers.js';
import { loadConfig } from './config/index.js';
import { getErrorMessage, logger } from './shared/utils/logger.js';

/**
 * Process entry point.
 *
 * Owns only what belongs to the process itself - reading configuration,
 * signals, and last-resort error reporting. What the bot is made of, and the
 * order it is assembled and torn down in, lives in the composition root.
 */
async function main(): Promise<void> {
  // Read and validate configuration before anything else can observe it.
  const config = loadConfig();

  logger.info('Starting Discord bot...');

  const app = createApp(config);
  installProcessHandlers(app, config.SHUTDOWN_TIMEOUT_MS);

  await app.start();

  logger.info('Discord bot started successfully');
}

main().catch((error) => {
  logger.error(`Failed to start bot: ${getErrorMessage(error)}`);
  if (error instanceof Error && error.stack) {
    logger.error(`Stack: ${error.stack}`);
  }
  process.exit(1);
});
