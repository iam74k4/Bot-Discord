import {
  backupService,
  type BackupResult,
} from '../../../infrastructure/backup/index.js';
import { getErrorMessage } from '../../../shared/utils/logger.js';

/**
 * Run a manual backup and always get a result back. `runBackup` reports most
 * failures in its result, but some (preparing the backup directory) throw;
 * both backup buttons show either kind as a failed backup instead of leaving
 * a "running" message behind.
 */
export async function runBackupSafely(): Promise<BackupResult> {
  try {
    return await backupService.runBackup();
  } catch (error) {
    return {
      success: false,
      filename: '',
      size: 0,
      timestamp: new Date(),
      error: getErrorMessage(error),
    };
  }
}
