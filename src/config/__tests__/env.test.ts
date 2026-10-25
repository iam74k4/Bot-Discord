import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { parseConfig, type EnvSource } from '../schema.js';

/**
 * Validation is a pure function of the environment it is handed, so these
 * tests never touch `process.env` or re-import modules to observe a throw.
 */
function source(overrides: EnvSource = {}): EnvSource {
  return {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CLIENT_ID: '123456789012345678',
    BOT_OWNER_IDS: '123456789012345678',
    NODE_ENV: 'development',
    ...overrides,
  };
}

describe('required settings', () => {
  it('names every missing required variable', () => {
    expect(() =>
      parseConfig({ DISCORD_TOKEN: undefined, DISCORD_CLIENT_ID: undefined })
    ).toThrow(/DISCORD_TOKEN, DISCORD_CLIENT_ID/);
  });

  it('requires a bot owner in production', () => {
    expect(() =>
      parseConfig(source({ NODE_ENV: 'production', BOT_OWNER_IDS: '' }))
    ).toThrow(/BOT_OWNER_IDS must be set in production/);
  });

  it('only warns about a missing bot owner in development', () => {
    const { warnings } = parseConfig(source({ BOT_OWNER_IDS: '' }));
    expect(warnings.join(' ')).toContain('BOT_OWNER_IDS is not set');
  });
});

describe('security validation', () => {
  it('rejects non-https alert webhooks', () => {
    expect(() =>
      parseConfig(
        source({ ALERT_WEBHOOK_URL: 'http://discord.com/api/webhooks/test/id' })
      )
    ).toThrow('ALERT_WEBHOOK_URL is not a valid HTTPS URL');
  });

  it('rejects path traversal outside the workspace root', () => {
    expect(() =>
      parseConfig(source({ DATABASE_PATH: '../outside/bot.db' }))
    ).toThrow('DATABASE_PATH must stay within the workspace root');
  });

  it('rejects absolute runtime directories', () => {
    expect(() =>
      parseConfig(source({ RECORDINGS_DIR: resolve('absolute-recordings') }))
    ).toThrow('RECORDINGS_DIR must be a relative path inside the workspace');
  });

  it('normalizes valid relative runtime paths', () => {
    const { config } = parseConfig(
      source({
        DATA_DIR: 'runtime-data',
        DATABASE_PATH: 'runtime-data/app.db',
        RECORDINGS_DIR: 'runtime-data/recordings',
        BACKUP_DIR: 'runtime-data/backups',
      })
    );

    expect(config.DATA_DIR).toBe('runtime-data/');
    expect(config.DATABASE_PATH).toBe('runtime-data/app.db');
    expect(config.RECORDINGS_DIR).toBe('runtime-data/recordings/');
    expect(config.BACKUP_DIR).toBe('runtime-data/backups/');
  });
});

describe('numeric validation', () => {
  it('rejects a non-integer where a number is required', () => {
    expect(() =>
      parseConfig(source({ MAX_RECORDING_DURATION: 'five minutes' }))
    ).toThrow(/Invalid integer.*MAX_RECORDING_DURATION/);
  });

  it('reports every invalid value at once', () => {
    expect(() =>
      parseConfig(
        source({
          MEMORY_LIMIT_MB: '16',
          MAX_CONCURRENT_VC_CONNECTIONS: '0',
          SHUTDOWN_TIMEOUT_MS: '1000',
        })
      )
    ).toThrow(
      /MEMORY_LIMIT_MB.*MAX_CONCURRENT_VC_CONNECTIONS.*SHUTDOWN_TIMEOUT_MS/s
    );
  });

  it('warns when the audio buffer is longer than anything recordable', () => {
    const { warnings } = parseConfig(
      source({ AUDIO_BUFFER_DURATION: '600', MAX_RECORDING_DURATION: '300' })
    );

    expect(warnings.join(' ')).toMatch(/can never be recorded/);
    expect(warnings.join(' ')).toMatch(/82MB per voice channel/);
  });

  it('warns when the buffer cannot hold a full recording', () => {
    const { warnings } = parseConfig(
      source({ AUDIO_BUFFER_DURATION: '60', MAX_RECORDING_DURATION: '300' })
    );

    expect(warnings.join(' ')).toMatch(/should be >= MAX_RECORDING_DURATION/);
  });
});

describe('defaults', () => {
  it('applies documented defaults when nothing is set', () => {
    const { config } = parseConfig(source());

    expect(config.AUDIO_BUFFER_DURATION).toBe(300);
    expect(config.MAX_RECORDING_DURATION).toBe(300);
    expect(config.MEMORY_LIMIT_MB).toBe(512);
    expect(config.MAX_CONCURRENT_VC_CONNECTIONS).toBe(5);
    expect(config.BACKUP_CRON).toBe('0 4 * * *');
    expect(config.SHUTDOWN_FINAL_BACKUP).toBe(true);
    expect(config.TZ).toBe('UTC');
  });

  it('falls back to development for an unrecognized NODE_ENV', () => {
    const { config, warnings } = parseConfig(source({ NODE_ENV: 'staging' }));

    expect(config.NODE_ENV).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(warnings.join(' ')).toContain(
      'NODE_ENV "staging" is not recognized'
    );
  });

  it('requests no restore unless RESTORE_BACKUP names one, trimmed', () => {
    expect(parseConfig(source()).config.RESTORE_BACKUP).toBe('');
    expect(
      parseConfig(
        source({ RESTORE_BACKUP: ' backup-2026-10-25T04-00-00-abcdef.db ' })
      ).config.RESTORE_BACKUP
    ).toBe('backup-2026-10-25T04-00-00-abcdef.db');
  });

  it('splits and trims the owner list', () => {
    const { config } = parseConfig(source({ BOT_OWNER_IDS: ' a , b ,, c ' }));
    expect(config.BOT_OWNER_IDS).toEqual(['a', 'b', 'c']);
  });
});
