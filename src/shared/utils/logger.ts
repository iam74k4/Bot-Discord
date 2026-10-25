/**
 * Log levels (lower index = more verbose)
 */
const LOG_LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLogLevel(): number {
  const level = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return level in LOG_LEVEL_PRIORITY
    ? LOG_LEVEL_PRIORITY[level]
    : process.env.NODE_ENV === 'development'
      ? LOG_LEVEL_PRIORITY.debug
      : LOG_LEVEL_PRIORITY.info;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

/**
 * Patterns for sensitive data masking.
 *
 * Bare 17-19 digit numbers are deliberately left alone: they are Discord
 * snowflakes (user, guild, channel ids) that logs need to stay useful. The
 * old Steam64 mask matched any 17-digit number and garbled 2015-2016
 * snowflakes; Steam support is gone, so the mask went with it.
 */
const MASK_PATTERNS: {
  pattern: RegExp;
  name: string;
}[] = [
  // Discord tokens (Bot/Bearer tokens format: base64.base64.base64)
  {
    pattern: /([\w-]{24,}\.[\w-]{6}\.[\w-]{27,})/g,
    name: 'token',
  },
  // Generic API keys (32 character hex strings)
  {
    pattern: /\b([A-F0-9]{32})\b/gi,
    name: 'apikey',
  },
  // Webhook URLs
  {
    pattern: /(https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+)/gi,
    name: 'webhook',
  },
];

/**
 * Mask sensitive data in a string
 */
function maskString(str: string): string {
  let masked = str;
  for (const { pattern, name } of MASK_PATTERNS) {
    masked = masked.replace(pattern, `[MASKED_${name.toUpperCase()}]`);
  }
  return masked;
}

/**
 * Recursively mask sensitive data in any value
 */
function maskSensitiveData(input: unknown): unknown {
  if (typeof input === 'string') {
    return maskString(input);
  }

  if (Array.isArray(input)) {
    return input.map(maskSensitiveData);
  }

  if (input !== null && typeof input === 'object') {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      // Mask values for sensitive key names
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('apikey') ||
        lowerKey.includes('api_key')
      ) {
        masked[key] = '[REDACTED]';
      } else {
        masked[key] = maskSensitiveData(value);
      }
    }
    return masked;
  }

  return input;
}

/**
 * Get timestamp string
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format log message with color
 */
function formatMessage(
  level: LogLevel,
  message: string,
  ...args: unknown[]
): string {
  const timestamp = `${colors.dim}${getTimestamp()}${colors.reset}`;
  let levelColor: string;
  let levelTag: string;

  switch (level) {
    case 'debug':
      levelColor = colors.cyan;
      levelTag = 'DEBUG';
      break;
    case 'info':
      levelColor = colors.green;
      levelTag = 'INFO';
      break;
    case 'warn':
      levelColor = colors.yellow;
      levelTag = 'WARN';
      break;
    case 'error':
      levelColor = colors.red;
      levelTag = 'ERROR';
      break;
  }

  const formattedLevel = `${levelColor}[${levelTag}]${colors.reset}`;

  // Mask sensitive data in message and args
  const maskedMessage = maskString(message);
  const formattedArgs =
    args.length > 0
      ? ' ' +
        args
          .map((arg) => {
            const masked = maskSensitiveData(arg);
            return typeof masked === 'object'
              ? JSON.stringify(masked, null, 2)
              : String(masked);
          })
          .join(' ')
      : '';

  return `${timestamp} ${formattedLevel} ${maskedMessage}${formattedArgs}`;
}

/**
 * Check if a log level should be emitted
 */
function shouldLog(level: LogLevel): boolean {
  const minLevel = getMinLogLevel();
  const levelPriority = LOG_LEVEL_PRIORITY[level] ?? 0;
  return levelPriority >= minLevel;
}

/**
 * Logger utility with automatic sensitive data masking
 */
/**
 * Safely extract an error message from an unknown thrown value.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const logger = {
  /**
   * Log debug message
   */
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) {
      console.log(formatMessage('debug', message, ...args));
    }
  },

  /**
   * Log info message
   */
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) {
      console.log(formatMessage('info', message, ...args));
    }
  },

  /**
   * Log warning message
   */
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', message, ...args));
    }
  },

  /**
   * Log error message
   */
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) {
      console.error(formatMessage('error', message, ...args));
    }
  },
};
