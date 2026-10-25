import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getErrorMessage, logger } from '../logger.js';

/**
 * The logger decides per call whether a level is enabled (LOG_LEVEL, else
 * NODE_ENV), prefixes a timestamp and coloured level tag, and masks secrets
 * before anything reaches the console. Console methods are spied and the
 * clock is frozen so whole lines can be compared.
 */

const NOW = new Date('2026-03-04T05:06:07.890Z');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;

const stamp = `${DIM}${NOW.toISOString()}${RESET}`;

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** The single line written to `spy`, as a string. */
function lineOf(spy: ReturnType<typeof vi.spyOn>): string {
  expect(spy).toHaveBeenCalledTimes(1);
  return String(spy.mock.calls[0][0]);
}

/** The text after the timestamp and level tag (`... [LEVEL]<reset> `). */
function bodyOf(spy: ReturnType<typeof vi.spyOn>): string {
  const line = lineOf(spy);
  const marker = `]${RESET} `;
  const start = line.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  return line.slice(start + marker.length);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('LOG_LEVEL', '');
  vi.stubEnv('NODE_ENV', 'production');
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('logger output', () => {
  it.each([
    ['debug', 'DEBUG', '36m', () => log],
    ['info', 'INFO', '32m', () => log],
    ['warn', 'WARN', '33m', () => warn],
    ['error', 'ERROR', '31m', () => error],
  ] as const)(
    '%s writes a timestamped, coloured line to the matching console method',
    (level, tag, color, spy) => {
      vi.stubEnv('LOG_LEVEL', 'debug');

      logger[level]('hello');

      expect(lineOf(spy())).toBe(
        `${stamp} ${ESC}${color}[${tag}]${RESET} hello`
      );
    }
  );

  it('appends extra arguments: strings and numbers as text, objects as indented JSON', () => {
    logger.info('values', 'plain', 42, null, undefined, { a: 1, b: [2] });

    expect(bodyOf(log)).toBe(
      `values plain 42 null undefined ${JSON.stringify({ a: 1, b: [2] }, null, 2)}`
    );
  });

  it('writes the bare message when there are no extra arguments', () => {
    logger.warn('just this');

    expect(bodyOf(warn)).toBe('just this');
  });
});

describe('log level selection', () => {
  function emitAll() {
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
  }

  function emitted(): string[] {
    return [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map(
      (call) => String(call[0]).slice(-1)
    );
  }

  it('hides debug by default in production', () => {
    emitAll();

    expect(emitted().sort()).toEqual(['e', 'i', 'w']);
  });

  it('shows debug by default in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    emitAll();

    expect(emitted().sort()).toEqual(['d', 'e', 'i', 'w']);
  });

  it.each([
    ['debug', ['d', 'e', 'i', 'w']],
    ['info', ['e', 'i', 'w']],
    ['warn', ['e', 'w']],
    ['error', ['e']],
    ['ERROR', ['e']],
    ['Warn', ['e', 'w']],
  ])('LOG_LEVEL=%s emits %j', (level, expected) => {
    vi.stubEnv('LOG_LEVEL', level);

    emitAll();

    expect(emitted().sort()).toEqual(expected);
  });

  it('LOG_LEVEL overrides the development default', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('LOG_LEVEL', 'error');

    emitAll();

    expect(emitted()).toEqual(['e']);
  });

  it('ignores an unrecognised LOG_LEVEL and falls back to the NODE_ENV default', () => {
    vi.stubEnv('LOG_LEVEL', 'verbose');

    emitAll();

    expect(emitted().sort()).toEqual(['e', 'i', 'w']);
  });

  it('re-reads the level on every call', () => {
    logger.debug('hidden');
    vi.stubEnv('LOG_LEVEL', 'debug');
    logger.debug('shown');

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('shown');
  });
});

describe('secret masking', () => {
  // Built at runtime so no token-shaped literal sits in the source.
  const discordToken = `${'M'.repeat(24)}.${'G'.repeat(6)}.${'x'.repeat(27)}`;
  const apiKey = 'deadBEEF'.repeat(4);
  const steamId = '76561198012345678';
  const webhook =
    'https://discord.com/api/webhooks/123456789012345678/abc_DEF-ghi';

  it('masks Discord tokens in the message', () => {
    logger.info(`login with ${discordToken} now`);

    expect(bodyOf(log)).toBe('login with [MASKED_TOKEN] now');
  });

  it('masks 32-character hex API keys', () => {
    logger.info(`key=${apiKey}`);

    expect(bodyOf(log)).toBe('key=[MASKED_APIKEY]');
  });

  it('partially masks 17-digit Steam IDs, keeping the ends', () => {
    logger.info(`steam ${steamId}`);

    expect(bodyOf(log)).toBe('steam 7656***5678');
  });

  it('masks webhook URLs', () => {
    logger.info(`posting to ${webhook}`);

    expect(bodyOf(log)).toBe('posting to [MASKED_WEBHOOK]');
  });

  it('leaves ordinary text alone', () => {
    logger.info('guild 123456789012345678 joined');

    expect(bodyOf(log)).toBe('guild 123456789012345678 joined');
  });

  it('leaves current 19-digit Discord snowflakes readable', () => {
    logger.info('user 1234567890123456789 joined');

    expect(bodyOf(log)).toBe('user 1234567890123456789 joined');
  });

  // KNOWN BUG (logger.ts, the Steam ID pattern `\b(\d{17})\b`): it matches any
  // standalone 17-digit number, so snowflakes from 2015-2016 accounts, guilds
  // and channels come out as "8138***2384". Steam64 IDs always start with
  // 7656119; once the pattern is anchored on that prefix, this test starts
  // failing: change `it.fails` to `it`.
  it.fails('leaves a 17-digit Discord snowflake readable', () => {
    logger.info('user 81384788765712384 joined');

    expect(bodyOf(log)).toBe('user 81384788765712384 joined');
  });

  it('masks string arguments too', () => {
    logger.error('failed:', `token ${discordToken}`);

    expect(bodyOf(error)).toBe('failed: token [MASKED_TOKEN]');
  });

  it('redacts values under sensitive keys, at any depth and in arrays', () => {
    logger.info('config', {
      DISCORD_TOKEN: 'abc',
      clientSecret: 'shh',
      Password: 'hunter2',
      apiKey: 'k',
      steam_api_key: 'k2',
      nested: { refreshToken: 'r', note: `id ${steamId}` },
      list: [{ secret: 's' }, `key ${apiKey}`, 7],
      name: 'bot',
    });

    const json = bodyOf(log).replace(/^config /, '');
    expect(JSON.parse(json)).toEqual({
      DISCORD_TOKEN: '[REDACTED]',
      clientSecret: '[REDACTED]',
      Password: '[REDACTED]',
      apiKey: '[REDACTED]',
      steam_api_key: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', note: 'id 7656***5678' },
      list: [{ secret: '[REDACTED]' }, 'key [MASKED_APIKEY]', 7],
      name: 'bot',
    });
  });

  it('masks every occurrence, not just the first', () => {
    logger.info(`${steamId} and ${steamId}`);

    expect(bodyOf(log)).toBe('7656***5678 and 7656***5678');
  });
});

describe('getErrorMessage', () => {
  it('returns the message of an Error', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['a number', 404, '404'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['an object', { code: 1 }, '[object Object]'],
  ])('stringifies %s', (_label, value, expected) => {
    expect(getErrorMessage(value)).toBe(expected);
  });
});
