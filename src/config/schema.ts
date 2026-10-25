import { isAbsolute, join, relative, resolve } from 'path';

/**
 * Configuration parsing and validation.
 *
 * Pure by design: it reads an environment object it is handed and either
 * returns a config or throws. Loading `.env` and reporting warnings belong to
 * the caller (`loadConfig`), which keeps importing this module free of side
 * effects and makes every rule testable without mutating `process.env`.
 */

export type NodeEnv = 'development' | 'production';

export interface AppConfig {
  readonly DISCORD_TOKEN: string;
  readonly DISCORD_CLIENT_ID: string;
  readonly DISCORD_GUILD_ID: string | null;
  readonly BOT_OWNER_IDS: readonly string[];
  readonly NODE_ENV: NodeEnv;
  readonly isDevelopment: boolean;
  readonly isProduction: boolean;

  readonly MAX_RECORDING_DURATION: number;
  readonly AUDIO_BUFFER_DURATION: number;
  readonly MAX_CONCURRENT_VC_CONNECTIONS: number;
  readonly RECORDING_RETENTION_HOURS: number;
  readonly VOICE_SESSION_RETENTION_DAYS: number;
  readonly AUDIT_LOG_RETENTION_DAYS: number;

  readonly DATA_DIR: string;
  readonly DATABASE_PATH: string;
  readonly RECORDINGS_DIR: string;

  readonly BACKUP_DIR: string;
  readonly BACKUP_RETENTION_DAYS: number;
  readonly BACKUP_CRON: string;
  readonly SHUTDOWN_FINAL_BACKUP: boolean;

  readonly MEMORY_LIMIT_MB: number;
  readonly SHUTDOWN_TIMEOUT_MS: number;
  readonly TZ: string;
  readonly ALERT_WEBHOOK_URL: string;
  readonly LOG_LEVEL: string;

  /**
   * Base URL of a VOICEVOX engine (e.g. http://voicevox.railway.internal:50021).
   * Empty disables text-to-speech, and with it the Message Content intent.
   */
  readonly VOICEVOX_URL: string;
}

export interface ConfigResult {
  config: AppConfig;
  /** Non-fatal findings for the caller to log. */
  warnings: string[];
}

export type EnvSource = Record<string, string | undefined>;

/** Normalize directory path to end with / */
function normalizeDirPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/');
  return trimmed.endsWith('/') ? trimmed : trimmed + '/';
}

function parseOwnerIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function isWithinWorkspaceRoot(baseDir: string, targetPath: string): boolean {
  const relativePath = relative(baseDir, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function validateWorkspacePath(
  value: string,
  envKey: string,
  options: { directory: boolean }
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${envKey} must not be empty`);
  }
  if (trimmed.includes('\0')) {
    throw new Error(`${envKey} must not contain null bytes`);
  }
  if (isAbsolute(trimmed)) {
    throw new Error(`${envKey} must be a relative path inside the workspace`);
  }
  if (!options.directory && /[\\/]+$/.test(trimmed)) {
    throw new Error(`${envKey} must point to a file path`);
  }

  const workspaceRoot = resolve(process.cwd());
  const resolvedPath = resolve(workspaceRoot, trimmed);
  if (!isWithinWorkspaceRoot(workspaceRoot, resolvedPath)) {
    throw new Error(`${envKey} must stay within the workspace root`);
  }

  const relativePath = relative(workspaceRoot, resolvedPath).replace(
    /\\/g,
    '/'
  );
  if (!relativePath || relativePath === '.') {
    return options.directory ? './' : '.';
  }
  return options.directory ? normalizeDirPath(relativePath) : relativePath;
}

/**
 * Parse an integer, requiring a valid value whenever the variable is set.
 */
function parseNumber(
  value: string | undefined,
  defaultValue: number,
  envKey: string
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid integer for environment variable ${envKey}: "${value}"`
    );
  }
  return parsed;
}

const REQUIRED_KEYS = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'] as const;

function requireKeys(source: EnvSource): void {
  const missing = REQUIRED_KEYS.filter((key) => !source[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. Please check your .env file.`
    );
  }
}

function parseAlertWebhook(source: EnvSource): string {
  const url = source.ALERT_WEBHOOK_URL;
  if (!url) return '';

  try {
    if (new URL(url).protocol !== 'https:') {
      throw new Error('ALERT_WEBHOOK_URL must use HTTPS');
    }
  } catch {
    throw new Error('ALERT_WEBHOOK_URL is not a valid HTTPS URL');
  }

  return url;
}

function parseVoicevoxUrl(source: EnvSource): string {
  const raw = source.VOICEVOX_URL?.trim();
  if (!raw) return '';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VOICEVOX_URL is not a valid URL');
  }
  // Plain http is allowed on purpose: the engine normally sits on a private
  // network next to the bot (Railway internal networking, docker compose).
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VOICEVOX_URL must use http or https');
  }

  return raw.replace(/\/+$/, '');
}

function parseNodeEnv(source: EnvSource, warnings: string[]): NodeEnv {
  const value = source.NODE_ENV;
  if (!value) return 'development';
  if (value === 'development' || value === 'production') return value;

  warnings.push(
    `NODE_ENV "${value}" is not recognized. Valid values: development, production`
  );
  return 'development';
}

/**
 * Build the application config, or throw with every problem found.
 */
export function parseConfig(source: EnvSource): ConfigResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  requireKeys(source);
  const alertWebhookUrl = parseAlertWebhook(source);
  const voicevoxUrl = parseVoicevoxUrl(source);
  const nodeEnv = parseNodeEnv(source, warnings);

  const num = (key: keyof AppConfig & string, fallback: number) =>
    parseNumber(source[key], fallback, key);

  const maxRecordingDuration = num('MAX_RECORDING_DURATION', 300);
  const audioBufferDuration = num('AUDIO_BUFFER_DURATION', 300);
  const memoryLimitMb = num('MEMORY_LIMIT_MB', 512);
  const maxVcConnections = num('MAX_CONCURRENT_VC_CONNECTIONS', 5);
  const recordingRetentionHours = num('RECORDING_RETENTION_HOURS', 24);
  const backupRetentionDays = num('BACKUP_RETENTION_DAYS', 7);
  const voiceSessionRetentionDays = num('VOICE_SESSION_RETENTION_DAYS', 30);
  const auditLogRetentionDays = num('AUDIT_LOG_RETENTION_DAYS', 90);
  const shutdownTimeoutMs = num('SHUTDOWN_TIMEOUT_MS', 10_000);

  if (maxRecordingDuration <= 0) {
    errors.push('MAX_RECORDING_DURATION must be > 0');
  }
  if (audioBufferDuration < maxRecordingDuration) {
    warnings.push(
      `AUDIO_BUFFER_DURATION (${audioBufferDuration}) should be >= MAX_RECORDING_DURATION (${maxRecordingDuration})`
    );
  }
  // Nothing longer than MAX_RECORDING_DURATION can ever be extracted, so the
  // extra ring length is memory (~0.27 MB per second per channel) spent for
  // no reachable capability.
  if (audioBufferDuration > maxRecordingDuration) {
    const wastedSeconds = audioBufferDuration - maxRecordingDuration;
    warnings.push(
      `AUDIO_BUFFER_DURATION (${audioBufferDuration}) exceeds MAX_RECORDING_DURATION (${maxRecordingDuration}); ` +
        `the extra ${wastedSeconds}s can never be recorded and costs about ` +
        `${((wastedSeconds * 48000 * 6) / (1024 * 1024)).toFixed(0)}MB per voice channel`
    );
  }
  if (memoryLimitMb < 128 || memoryLimitMb > 8192) {
    errors.push('MEMORY_LIMIT_MB must be between 128 and 8192');
  }
  if (maxVcConnections <= 0 || maxVcConnections > 100) {
    errors.push('MAX_CONCURRENT_VC_CONNECTIONS must be between 1 and 100');
  }
  if (recordingRetentionHours <= 0) {
    errors.push('RECORDING_RETENTION_HOURS must be > 0');
  }
  if (backupRetentionDays <= 0) {
    errors.push('BACKUP_RETENTION_DAYS must be > 0');
  }
  if (voiceSessionRetentionDays <= 0) {
    errors.push('VOICE_SESSION_RETENTION_DAYS must be > 0');
  }
  if (auditLogRetentionDays <= 0) {
    errors.push('AUDIT_LOG_RETENTION_DAYS must be > 0');
  }
  if (shutdownTimeoutMs < 5_000 || shutdownTimeoutMs > 120_000) {
    errors.push('SHUTDOWN_TIMEOUT_MS must be between 5000 and 120000');
  }

  const ownerIds = parseOwnerIds(source.BOT_OWNER_IDS);
  if (ownerIds.length === 0) {
    if (nodeEnv === 'production') {
      errors.push(
        'BOT_OWNER_IDS must be set in production with at least one Discord user ID (comma-separated).'
      );
    } else {
      warnings.push(
        'BOT_OWNER_IDS is not set. The /owner command will reject everyone until you add at least one ID.'
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed: ${errors.join('; ')}`);
  }

  return {
    warnings,
    config: {
      DISCORD_TOKEN: source.DISCORD_TOKEN!,
      DISCORD_CLIENT_ID: source.DISCORD_CLIENT_ID!,
      DISCORD_GUILD_ID: source.DISCORD_GUILD_ID || null,
      BOT_OWNER_IDS: ownerIds,
      NODE_ENV: nodeEnv,
      isDevelopment: nodeEnv !== 'production',
      isProduction: nodeEnv === 'production',

      MAX_RECORDING_DURATION: maxRecordingDuration,
      AUDIO_BUFFER_DURATION: audioBufferDuration,
      MAX_CONCURRENT_VC_CONNECTIONS: maxVcConnections,
      RECORDING_RETENTION_HOURS: recordingRetentionHours,
      VOICE_SESSION_RETENTION_DAYS: voiceSessionRetentionDays,
      AUDIT_LOG_RETENTION_DAYS: auditLogRetentionDays,

      DATA_DIR: validateWorkspacePath(source.DATA_DIR || 'data/', 'DATA_DIR', {
        directory: true,
      }),
      DATABASE_PATH: validateWorkspacePath(
        source.DATABASE_PATH || join('data', 'bot.db'),
        'DATABASE_PATH',
        { directory: false }
      ),
      RECORDINGS_DIR: validateWorkspacePath(
        source.RECORDINGS_DIR || 'data/recordings/',
        'RECORDINGS_DIR',
        { directory: true }
      ),
      BACKUP_DIR: validateWorkspacePath(
        source.BACKUP_DIR || 'data/backups/',
        'BACKUP_DIR',
        { directory: true }
      ),

      BACKUP_RETENTION_DAYS: backupRetentionDays,
      BACKUP_CRON: source.BACKUP_CRON || '0 4 * * *',
      SHUTDOWN_FINAL_BACKUP: source.SHUTDOWN_FINAL_BACKUP !== 'false',

      MEMORY_LIMIT_MB: memoryLimitMb,
      SHUTDOWN_TIMEOUT_MS: shutdownTimeoutMs,
      TZ: source.TZ || 'UTC',
      ALERT_WEBHOOK_URL: alertWebhookUrl,
      LOG_LEVEL: source.LOG_LEVEL || '',
      VOICEVOX_URL: voicevoxUrl,
    },
  };
}
