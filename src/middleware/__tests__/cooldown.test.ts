import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import {
  clearCooldown,
  cooldownMiddleware,
  releaseCooldown,
  resolveCooldownMs,
} from '../cooldown/cooldownMiddleware.js';
import { cooldownStore } from '../cooldown/index.js';
import { Command } from '../../shared/types/index.js';
import { t } from '../../locales/index.js';
import {
  clearCommandIds,
  setCommandIds,
} from '../../shared/utils/commandMentions.js';

/**
 * The cooldown is keyed by the full subcommand path and runs on the real
 * store with fake time, so "blocked for exactly this long" is observable.
 */

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../locales/guildLocale.js', () => ({ resolveLocale }));

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

function invoke(
  commandName: string,
  sub: string | null = null,
  group: string | null = null,
  userId = 'user-123'
) {
  return {
    commandName,
    user: { id: userId },
    guildId: 'guild-1',
    locale: 'en-US',
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group,
    },
  } as unknown as ChatInputCommandInteraction;
}

function createCommand(name: string, options?: Command['options']): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription('test'),
    middleware: ['cooldown'],
    options,
    execute: vi.fn(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resolveLocale.mockReturnValue('en');
  cooldownStore.clearAll();
});

afterEach(() => {
  cooldownStore.clearAll();
  clearCommandIds();
  vi.useRealTimers();
});

describe('cooldownMiddleware', () => {
  it('lets the first use through and blocks a repeat until it expires', async () => {
    const command = createCommand('test', { cooldown: 5000 });

    expect((await cooldownMiddleware(invoke('test'), command)).success).toBe(
      true
    );
    vi.advanceTimersByTime(4999);
    expect((await cooldownMiddleware(invoke('test'), command)).success).toBe(
      false
    );
    vi.advanceTimersByTime(1);
    expect((await cooldownMiddleware(invoke('test'), command)).success).toBe(
      true
    );
  });

  it('keys the cooldown by the full subcommand path', async () => {
    const community = createCommand('community', { cooldown: 10_000 });

    await cooldownMiddleware(invoke('community', 'create', 'poll'), community);

    // A sibling subcommand is not held up by the one just used...
    expect(
      (await cooldownMiddleware(invoke('community', 'end', 'poll'), community))
        .success
    ).toBe(true);
    // ...but the same path is.
    expect(
      (
        await cooldownMiddleware(
          invoke('community', 'create', 'poll'),
          community
        )
      ).success
    ).toBe(false);
    expect(
      cooldownStore.isOnCooldown('community poll create', 'user-123')
    ).toBe(true);
  });

  it('keeps users apart', async () => {
    const command = createCommand('test', { cooldown: 5000 });
    await cooldownMiddleware(invoke('test', null, null, 'a'), command);

    expect(
      (await cooldownMiddleware(invoke('test', null, null, 'b'), command))
        .success
    ).toBe(true);
  });

  it('names the full path and the whole seconds left, under its own title', async () => {
    const command = createCommand('voice', { cooldown: 10_000 });
    await cooldownMiddleware(invoke('voice', 'record'), command);
    vi.advanceTimersByTime(1_500);

    const result = await cooldownMiddleware(invoke('voice', 'record'), command);

    expect(result).toEqual({
      success: false,
      title: t('common.cooldownTitle', 'en'),
      message: t('common.cooldown', 'en', {
        seconds: 9, // 8.5 s rounds up: never "0 seconds"
        command: '`/voice record`',
      }),
    });
  });

  it('turns the path into a clickable mention once command ids are known', async () => {
    setCommandIds([{ name: 'voice', id: '987' }]);
    resolveLocale.mockReturnValue('ja');
    const command = createCommand('voice', { cooldown: 10_000 });
    await cooldownMiddleware(invoke('voice', 'record'), command);

    const result = await cooldownMiddleware(invoke('voice', 'record'), command);

    expect(result.message).toBe(
      t('common.cooldown', 'ja', {
        seconds: 10,
        command: '</voice record:987>',
      })
    );
  });

  it('does not start a cooldown when its length is 0 or negative', async () => {
    for (const cooldown of [0, -1]) {
      const command = createCommand('free', { cooldown });
      await cooldownMiddleware(invoke('free'), command);

      expect((await cooldownMiddleware(invoke('free'), command)).success).toBe(
        true
      );
    }
    expect(cooldownStore.isOnCooldown('free', 'user-123')).toBe(false);
  });

  it('uses a 3 second default when the command declares none', async () => {
    const command = createCommand('test');
    await cooldownMiddleware(invoke('test'), command);

    vi.advanceTimersByTime(2_999);
    expect((await cooldownMiddleware(invoke('test'), command)).success).toBe(
      false
    );
    vi.advanceTimersByTime(1);
    expect((await cooldownMiddleware(invoke('test'), command)).success).toBe(
      true
    );
  });

  it('applies per-path cooldowns, with 0 switching one path off', async () => {
    const voice = createCommand('voice', {
      cooldown: 10_000,
      cooldowns: { 'voice record': 10_000, 'voice status': 0 },
    });

    await cooldownMiddleware(invoke('voice', 'status'), voice);
    expect(
      (await cooldownMiddleware(invoke('voice', 'status'), voice)).success
    ).toBe(true);

    await cooldownMiddleware(invoke('voice', 'record'), voice);
    expect(
      (await cooldownMiddleware(invoke('voice', 'record'), voice)).success
    ).toBe(false);
  });
});

describe('resolveCooldownMs', () => {
  const voice = createCommand('voice', {
    cooldown: 7_000,
    cooldowns: {
      'voice record': 10_000,
      'voice autojoin': 2_000,
      'voice autojoin exclude': 1_000,
    },
  });

  it.each([
    ['voice record', 10_000],
    ['voice autojoin enable', 2_000],
    ['voice autojoin exclude', 1_000],
    ['voice status', 7_000],
  ])('%s -> %d ms (longest matching key, then cooldown)', (path, expected) => {
    expect(resolveCooldownMs(voice, path)).toBe(expected);
  });

  it('falls back to the default without any configuration', () => {
    expect(resolveCooldownMs(createCommand('x'), 'x y')).toBe(3000);
  });

  it('does not match a key that is only a string prefix of a word', () => {
    const command = createCommand('voice', {
      cooldowns: { 'voice rec': 1 },
    });

    expect(resolveCooldownMs(command, 'voice record')).toBe(3000);
  });
});

describe('releaseCooldown', () => {
  it('gives back the cooldown this interaction started, and only that one', async () => {
    const command = createCommand('community', { cooldown: 10_000 });
    await cooldownMiddleware(
      invoke('community', 'member', 'roulette'),
      command
    );
    await cooldownMiddleware(invoke('community', 'team', 'roulette'), command);

    releaseCooldown(invoke('community', 'member', 'roulette'));

    expect(
      (
        await cooldownMiddleware(
          invoke('community', 'member', 'roulette'),
          command
        )
      ).success
    ).toBe(true);
    expect(
      cooldownStore.isOnCooldown('community roulette team', 'user-123')
    ).toBe(true);
  });
});

describe('clearCooldown', () => {
  it('clears a command and every subcommand path under it', async () => {
    const command = createCommand('voice', { cooldown: 10_000 });
    await cooldownMiddleware(invoke('voice', 'record'), command);
    await cooldownMiddleware(invoke('voice', 'exclude', 'autojoin'), command);

    clearCooldown('voice', 'user-123');

    expect(cooldownStore.isOnCooldown('voice record', 'user-123')).toBe(false);
    expect(
      cooldownStore.isOnCooldown('voice autojoin exclude', 'user-123')
    ).toBe(false);
  });
});
