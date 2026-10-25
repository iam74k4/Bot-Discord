import {
  startDailyCleanup,
  stopCleanupInterval,
} from '../../shared/utils/cleanup.js';
import { logger } from '../../shared/utils/logger.js';
import { pollRepository } from './poll/index.js';

export const name = 'community';

let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Discord owns polls now, so there is nothing to restore on boot - only stale
 * pointers to polls it has already closed, which are pruned daily.
 */
function prunePollPointers(): void {
  const removed = pollRepository.removeExpired();
  if (removed > 0) {
    logger.info(`Pruned ${removed} expired poll record(s)`);
  }
}

export function start(): void {
  if (cleanupInterval) return;
  prunePollPointers();
  cleanupInterval = startDailyCleanup(
    prunePollPointers,
    'Poll pointer pruning'
  );
  logger.info('Community feature started');
}

export function stop(): void {
  cleanupInterval = stopCleanupInterval(cleanupInterval);
}
