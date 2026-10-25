import { describe, expect, it } from 'vitest';
import { parseConfig, type EnvSource } from '../schema.js';

/**
 * ALLOWED_GUILD_IDS limits a deployment (staging) to named servers. A typo
 * would lock the bot out of the server it was meant for, so bad entries fail
 * startup instead of being dropped.
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

describe('ALLOWED_GUILD_IDS', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['only separators', ' , ,'],
  ])('serves every server when %s', (_label, value) => {
    const { config, warnings } = parseConfig(
      source({ ALLOWED_GUILD_IDS: value })
    );

    expect(config.ALLOWED_GUILD_IDS).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('splits, trims and de-duplicates the list', () => {
    const { config } = parseConfig(
      source({
        ALLOWED_GUILD_IDS:
          ' 111111111111111111 ,22222222222222222222,111111111111111111',
      })
    );

    expect(config.ALLOWED_GUILD_IDS).toEqual([
      '111111111111111111',
      '22222222222222222222',
    ]);
  });

  it('rejects anything that is not a server ID, naming it', () => {
    expect(() =>
      parseConfig(
        source({ ALLOWED_GUILD_IDS: '111111111111111111,my-server,12345' })
      )
    ).toThrow(
      'ALLOWED_GUILD_IDS must be comma-separated Discord server IDs; not an ID: my-server, 12345'
    );
  });

  it('warns when the command-registration server is not allowed', () => {
    const { warnings } = parseConfig(
      source({
        ALLOWED_GUILD_IDS: '111111111111111111',
        DISCORD_GUILD_ID: '222222222222222222',
      })
    );

    expect(warnings).toContain(
      'DISCORD_GUILD_ID (222222222222222222) is not in ALLOWED_GUILD_IDS; commands will be registered to a server the bot refuses to serve'
    );
  });

  it('does not warn when the command-registration server is allowed', () => {
    const { warnings } = parseConfig(
      source({
        ALLOWED_GUILD_IDS: '111111111111111111',
        DISCORD_GUILD_ID: '111111111111111111',
      })
    );

    expect(warnings).toEqual([]);
  });
});
