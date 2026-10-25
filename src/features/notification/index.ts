import type { FeatureContext } from '../index.js';
import { voiceTracker } from './tracking/voiceTracker.js';
import { voiceSessionRepository } from './repositories/voiceSessionRepository.js';
import { logger } from '../../shared/utils/logger.js';
import {
  startDailyCleanup,
  stopCleanupInterval,
} from '../../shared/utils/cleanup.js';
import { registerSettingsSummary } from '../../shared/settingsSummary/index.js';
import { resetVoiceDigests } from './events/voiceNotification.js';
import { DEFAULT_STATS_TIME_ZONE, setStatsTimeZone } from './stats/calendar.js';
import { notificationSettingsSummary } from './application/settingsSummary.js';

export const name = 'notification';
let cleanupInterval: NodeJS.Timeout | null = null;
let unregisterSummary: (() => void) | null = null;

function cleanupOldVoiceSessions(retentionDays: number): void {
  const deleted = voiceSessionRepository.cleanupOldSessions(retentionDays);
  if (deleted > 0) {
    logger.info(`Cleaned up ${deleted} old voice session record(s)`);
  }
}

export function start({ client, config }: FeatureContext): void {
  if (cleanupInterval) {
    return;
  }
  // Before anything can close a session: the rollup is keyed by this zone.
  setStatsTimeZone(config.STATS_TIMEZONE || DEFAULT_STATS_TIME_ZONE);
  voiceTracker.closeAllStaleSessions();
  voiceTracker.reconcileActiveVoiceSessions(client);
  cleanupInterval = startDailyCleanup(
    () => cleanupOldVoiceSessions(config.VOICE_SESSION_RETENTION_DAYS),
    'Voice session retention'
  );
  unregisterSummary = registerSettingsSummary(
    'notification',
    notificationSettingsSummary,
    { order: 20 }
  );
  logger.info('Notification feature started');
}

export function stop(): void {
  voiceTracker.endAllSessions();
  resetVoiceDigests();
  cleanupInterval = stopCleanupInterval(cleanupInterval);
  unregisterSummary?.();
  unregisterSummary = null;
}
