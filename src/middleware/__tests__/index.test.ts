import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  type EmbedBuilder,
} from 'discord.js';
import type {
  Command,
  MiddlewareName,
  MiddlewareResult,
} from '../../shared/types/index.js';
import { clearCooldown, runMiddleware } from '../index.js';
import { t } from '../../locales/index.js';
import { COLORS } from '../../shared/utils/constants/index.js';

/**
 * `runMiddleware` is the gate in front of every slash command: it runs the
 * command's middleware in the order the command lists them, stops at the
 * first rejection, and tells the user why. The individual middlewares have
 * their own tests; here they are replaced with spies so the pipeline's
 * ordering, short-circuiting, and rejection reply can be observed directly.
 */

const permissionsMiddleware = vi.hoisted(() => vi.fn());
const cooldownMiddleware = vi.hoisted(() => vi.fn());
const cooldownClear = vi.hoisted(() => vi.fn());
vi.mock('../permissions.js', () => ({ permissionsMiddleware }));
vi.mock('../cooldown/index.js', () => ({
  cooldownMiddleware,
  clearCooldown: cooldownClear,
}));

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../locales/guildLocale.js', () => ({ resolveLocale }));

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const pass: MiddlewareResult = { success: true };

function interaction(
  state: { deferred?: boolean; replied?: boolean } = {},
  responders: { reply?: Mock; editReply?: Mock } = {}
) {
  const reply = responders.reply ?? vi.fn().mockResolvedValue(undefined);
  const editReply =
    responders.editReply ?? vi.fn().mockResolvedValue(undefined);
  const stub = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    locale: 'en-US',
    deferred: state.deferred ?? false,
    replied: state.replied ?? false,
    reply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction: stub, reply, editReply };
}

function command(middleware?: MiddlewareName[]): Command {
  return {
    data: new SlashCommandBuilder().setName('test').setDescription('test'),
    middleware,
    execute: vi.fn(),
  };
}

function embedOf(mock: Mock) {
  const payload = mock.mock.calls[0][0] as { embeds: EmbedBuilder[] };
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
  permissionsMiddleware.mockResolvedValue(pass);
  cooldownMiddleware.mockResolvedValue(pass);
});

describe('runMiddleware', () => {
  it.each([
    ['undefined', undefined],
    ['empty', []],
  ])('passes a command whose middleware list is %s', async (_label, list) => {
    const { interaction: i, reply, editReply } = interaction();

    await expect(runMiddleware(i, command(list))).resolves.toBe(true);

    expect(permissionsMiddleware).not.toHaveBeenCalled();
    expect(cooldownMiddleware).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it.each<[MiddlewareName[], string[]]>([
    [
      ['permissions', 'cooldown'],
      ['permissions', 'cooldown'],
    ],
    [
      ['cooldown', 'permissions'],
      ['cooldown', 'permissions'],
    ],
  ])('runs %j in the declared order', async (list, expected) => {
    const order: string[] = [];
    permissionsMiddleware.mockImplementation(async () => {
      order.push('permissions');
      return pass;
    });
    cooldownMiddleware.mockImplementation(async () => {
      order.push('cooldown');
      return pass;
    });
    const { interaction: i, reply } = interaction();
    const cmd = command(list);

    await expect(runMiddleware(i, cmd)).resolves.toBe(true);

    expect(order).toEqual(expected);
    expect(permissionsMiddleware).toHaveBeenCalledWith(i, cmd);
    expect(cooldownMiddleware).toHaveBeenCalledWith(i, cmd);
    expect(reply).not.toHaveBeenCalled();
  });

  it('stops at the first rejection without running later middleware', async () => {
    permissionsMiddleware.mockResolvedValue({
      success: false,
      message: 'Missing Manage Server',
    });
    const { interaction: i } = interaction();

    await expect(
      runMiddleware(i, command(['permissions', 'cooldown']))
    ).resolves.toBe(false);

    // A rejected user must not also be charged a cooldown.
    expect(cooldownMiddleware).not.toHaveBeenCalled();
  });

  it('tells the user why, in an ephemeral error embed', async () => {
    cooldownMiddleware.mockResolvedValue({
      success: false,
      message: 'Please wait 2.0 seconds',
    });
    const { interaction: i, reply, editReply } = interaction();

    await runMiddleware(i, command(['cooldown']));

    expect(reply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(reply)).toMatchObject({
      title: t('common.commandBlocked', 'en'),
      description: 'Please wait 2.0 seconds',
      color: COLORS.ERROR,
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'falls back to the no-permission text when the rejection message is %s',
    async (_label, message) => {
      permissionsMiddleware.mockResolvedValue({ success: false, message });
      const { interaction: i, reply } = interaction();

      await runMiddleware(i, command(['permissions']));

      expect(embedOf(reply).description).toBe(t('common.noPermission', 'en'));
    }
  );

  it('localises the rejection title', async () => {
    resolveLocale.mockReturnValue('ja');
    permissionsMiddleware.mockResolvedValue({ success: false });
    const { interaction: i, reply } = interaction();

    await runMiddleware(i, command(['permissions']));

    expect(resolveLocale).toHaveBeenCalledWith(i);
    expect(embedOf(reply)).toMatchObject({
      title: t('common.commandBlocked', 'ja'),
      description: t('common.noPermission', 'ja'),
    });
  });

  it.each([
    ['deferred', { deferred: true }],
    ['replied', { replied: true }],
  ])(
    'edits the reply instead of replying when the interaction was already %s',
    async (_label, state) => {
      permissionsMiddleware.mockResolvedValue({
        success: false,
        message: 'nope',
      });
      const { interaction: i, reply, editReply } = interaction(state);

      await expect(runMiddleware(i, command(['permissions']))).resolves.toBe(
        false
      );

      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      expect(editReply.mock.calls[0][0]).not.toHaveProperty('flags');
      expect(embedOf(editReply).description).toBe('nope');
    }
  );

  it('still blocks the command when the rejection reply fails', async () => {
    permissionsMiddleware.mockResolvedValue({ success: false, message: 'x' });
    const { interaction: i } = interaction(
      {},
      { reply: vi.fn().mockRejectedValue(new Error('Unknown interaction')) }
    );

    await expect(runMiddleware(i, command(['permissions']))).resolves.toBe(
      false
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to send middleware rejection: Unknown interaction'
    );
  });

  it('still blocks the command when the rejection edit fails', async () => {
    permissionsMiddleware.mockResolvedValue({ success: false, message: 'x' });
    const { interaction: i } = interaction(
      { deferred: true },
      { editReply: vi.fn().mockRejectedValue(new Error('Unknown Message')) }
    );

    await expect(runMiddleware(i, command(['permissions']))).resolves.toBe(
      false
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to send middleware rejection: Unknown Message'
    );
  });

  it('warns about and skips an unknown middleware name, then continues', async () => {
    const { interaction: i } = interaction();

    await expect(
      runMiddleware(i, command(['ratelimit' as MiddlewareName, 'permissions']))
    ).resolves.toBe(true);

    expect(logger.warn).toHaveBeenCalledWith('Unknown middleware: ratelimit');
    expect(permissionsMiddleware).toHaveBeenCalledTimes(1);
  });

  it('propagates a middleware crash to the caller without replying', async () => {
    const crash = new Error('db down');
    permissionsMiddleware.mockRejectedValue(crash);
    const { interaction: i, reply, editReply } = interaction();

    await expect(
      runMiddleware(i, command(['permissions', 'cooldown']))
    ).rejects.toBe(crash);

    expect(cooldownMiddleware).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });
});

describe('clearCooldown re-export', () => {
  it('delegates to the cooldown module', () => {
    clearCooldown('test', 'user-1');

    expect(cooldownClear).toHaveBeenCalledWith('test', 'user-1');
  });
});
