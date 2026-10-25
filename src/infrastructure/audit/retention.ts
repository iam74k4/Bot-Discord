import { env } from '../../config/index.js';
import { logger } from '../../shared/utils/logger.js';
import {
  startDailyCleanup,
  stopCleanupInterval,
} from '../../shared/utils/cleanup.js';
import { auditRepository } from './auditRepository.js';

/**
 * Retention for `audit_logs`.
 *
 * Scheduling lives with the table's owner. The admin feature used to run this
 * because it displays the logs, which meant deleting the bot's audit trail
 * depended on a feature staying loaded.
 */
let cleanupInterval: NodeJS.Timeout | null = null;

function cleanupOldAuditLogs(): void {
  const deleted = auditRepository.deleteOldLogs(env.AUDIT_LOG_RETENTION_DAYS);
  if (deleted > 0) {
    logger.info(`Cleaned up ${deleted} old audit log(s)`);
  }
}

export function startAuditRetention(): void {
  if (cleanupInterval) return;
  cleanupInterval = startDailyCleanup(
    cleanupOldAuditLogs,
    'Audit log retention'
  );
}

export function stopAuditRetention(): void {
  cleanupInterval = stopCleanupInterval(cleanupInterval);
}
