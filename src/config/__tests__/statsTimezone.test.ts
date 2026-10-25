import { describe, expect, it } from 'vitest';
import { parseConfig, type EnvSource } from '../schema.js';

/**
 * STATS_TIMEZONE decides where a day starts in `/notification stats`. A typo
 * would silently move everyone's "today", so an explicit value must be a real
 * zone; `TZ` is only a fallback and may hold values Intl cannot read.
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

describe('STATS_TIMEZONE', () => {
  it('defaults to Japan time when neither it nor TZ is set', () => {
    const { config } = parseConfig(source());

    expect(config.STATS_TIMEZONE).toBe('Asia/Tokyo');
    // TZ keeps its own default: it schedules the backup cron.
    expect(config.TZ).toBe('UTC');
  });

  it('follows TZ when only TZ is set', () => {
    expect(
      parseConfig(source({ TZ: 'Europe/Berlin' })).config.STATS_TIMEZONE
    ).toBe('Europe/Berlin');
  });

  it('prefers its own value over TZ', () => {
    const { config } = parseConfig(
      source({ TZ: 'UTC', STATS_TIMEZONE: ' Asia/Tokyo ' })
    );

    expect(config.STATS_TIMEZONE).toBe('Asia/Tokyo');
    expect(config.TZ).toBe('UTC');
  });

  it('stores the canonical spelling of the zone', () => {
    expect(
      parseConfig(source({ STATS_TIMEZONE: 'america/new_york' })).config
        .STATS_TIMEZONE
    ).toBe('America/New_York');
  });

  it('refuses to start with a zone that does not exist', () => {
    expect(() => parseConfig(source({ STATS_TIMEZONE: 'Asia/Tokio' }))).toThrow(
      /STATS_TIMEZONE "Asia\/Tokio" is not a valid IANA time zone/
    );
  });

  it('warns and uses Japan time when TZ is not a zone Intl understands', () => {
    const { config, warnings } = parseConfig(source({ TZ: 'JST-9' }));

    expect(config.STATS_TIMEZONE).toBe('Asia/Tokyo');
    expect(warnings).toContainEqual(expect.stringContaining('TZ "JST-9"'));
  });
});
