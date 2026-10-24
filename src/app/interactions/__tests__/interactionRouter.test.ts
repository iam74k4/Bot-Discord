import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  ApplicationCommandType,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Collection,
  ComponentType,
  InteractionType,
  MessageFlags,
  ModalSubmitInteraction,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  StringSelectMenuInteraction,
  UserContextMenuCommandInteraction,
  type EmbedBuilder,
  type Interaction,
} from 'discord.js';
import type { ExtendedClient } from '../../../client.js';
import type { Command } from '../../../shared/types/index.js';
import { routeInteraction } from '../interactionRouter.js';
import { clearCooldown, runMiddleware } from '../../../middleware/index.js';
import { cooldownStore } from '../../../middleware/cooldown/cooldownStore.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';

/**
 * The router is the single entry point for every interaction the gateway
 * delivers. Slash commands run through the real middleware pipeline (spied, so
 * individual tests can force an outcome) and the real cooldown store, so the
 * "a failed command does not cost the user a cooldown" contract is exercised
 * end to end. Interactions are built on discord.js prototypes so the router's
 * `isAutocomplete()` / `isChatInputCommand()` checks are the library's own.
 * Those checks read the `type` / `commandType` fields set below (true as of
 * discord.js 14.26); the "test fixtures" block fails first if an upgrade
 * changes which fields they read.
 */

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', () => ({ resolveLocale }));

vi.mock('../../../middleware/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../middleware/index.js')>();
  return {
    ...actual,
    runMiddleware: vi.fn(actual.runMiddleware),
    clearCooldown: vi.fn(actual.clearCooldown),
  };
});

const USER_ID = 'user-1';

/** Build an object on a discord.js prototype with the given own fields. */
function onPrototype<T>(proto: object, fields: Record<string, unknown>): T {
  const target: Record<string, unknown> = Object.create(proto);
  for (const [key, value] of Object.entries(fields)) {
    // defineProperty, not assignment: some fields (e.g. `guild`) are
    // getter-only accessors on the prototype.
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return target as T;
}

interface ChatInputStub {
  interaction: ChatInputCommandInteraction;
  reply: Mock;
  editReply: Mock;
  followUp: Mock;
}

function chatInput(
  options: {
    commandName?: string;
    deferred?: boolean;
    replied?: boolean;
    permissions?: bigint[];
    reply?: Mock;
    editReply?: Mock;
  } = {}
): ChatInputStub {
  const reply = options.reply ?? vi.fn().mockResolvedValue(undefined);
  const editReply = options.editReply ?? vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const interaction = onPrototype<ChatInputCommandInteraction>(
    ChatInputCommandInteraction.prototype,
    {
      type: InteractionType.ApplicationCommand,
      commandType: ApplicationCommandType.ChatInput,
      commandName: options.commandName ?? 'ping',
      user: { id: USER_ID, tag: 'tester#0001' },
      guildId: 'guild-1',
      guild: { id: 'guild-1' },
      member: { permissions: new PermissionsBitField(options.permissions) },
      locale: 'en-US',
      deferred: options.deferred ?? false,
      replied: options.replied ?? false,
      reply,
      editReply,
      followUp,
    }
  );
  return { interaction, reply, editReply, followUp };
}

function autocomplete(commandName: string, respond?: Mock) {
  const respondMock = respond ?? vi.fn().mockResolvedValue(undefined);
  const interaction = onPrototype<AutocompleteInteraction>(
    AutocompleteInteraction.prototype,
    {
      type: InteractionType.ApplicationCommandAutocomplete,
      commandType: ApplicationCommandType.ChatInput,
      commandName,
      user: { id: USER_ID },
      guildId: 'guild-1',
      locale: 'en-US',
      respond: respondMock,
    }
  );
  return { interaction, respond: respondMock };
}

function command(
  overrides: Partial<Omit<Command, 'data'>> & { name?: string } = {}
): Command & { execute: Mock } {
  const { name = 'ping', ...rest } = overrides;
  return {
    data: new SlashCommandBuilder().setName(name).setDescription('test'),
    execute: vi.fn().mockResolvedValue(undefined),
    ...rest,
  } as Command & { execute: Mock };
}

function clientWith(...commands: Command[]): ExtendedClient {
  const collection = new Collection<string, Command>();
  for (const item of commands) collection.set(item.data.name, item);
  return { commands: collection } as unknown as ExtendedClient;
}

/** The single embed of the first payload a reply mock was called with. */
function embedOf(mock: Mock, call = 0) {
  const payload = mock.mock.calls[call][0] as { embeds: EmbedBuilder[] };
  expect(payload.embeds).toHaveLength(1);
  return payload.embeds[0].toJSON();
}

/**
 * Let every promise continuation that is already queued run. Enough rounds
 * that an un-awaited handler would have long finished, without real time.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function responsesSent(stub: ChatInputStub): number {
  return (
    stub.reply.mock.calls.length +
    stub.editReply.mock.calls.length +
    stub.followUp.mock.calls.length
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
  metrics.reset();
  cooldownStore.clearAll();
});

afterEach(() => {
  cooldownStore.clearAll();
  vi.useRealTimers();
});

describe('test fixtures', () => {
  // The stubs only work if discord.js's own type guards accept them; pin that
  // here so a library upgrade breaks this block rather than the router tests.
  it('builds interactions that pass the discord.js type guards', () => {
    const slash = chatInput().interaction;
    const auto = autocomplete('search').interaction;

    expect(slash.isChatInputCommand()).toBe(true);
    expect(slash.isAutocomplete()).toBe(false);
    expect(auto.isAutocomplete()).toBe(true);
    expect(auto.isChatInputCommand()).toBe(false);
  });
});

describe('routeInteraction: slash commands', () => {
  it('runs middleware and executes the matching command', async () => {
    const ping = command();
    const stub = chatInput();

    await routeInteraction(clientWith(ping), stub.interaction);

    expect(runMiddleware).toHaveBeenCalledWith(stub.interaction, ping);
    expect(ping.execute).toHaveBeenCalledTimes(1);
    expect(ping.execute).toHaveBeenCalledWith(stub.interaction);
    expect(responsesSent(stub)).toBe(0);
  });

  it('dispatches by command name only to the matching command', async () => {
    const ping = command({ name: 'ping' });
    const help = command({ name: 'help' });

    await routeInteraction(
      clientWith(ping, help),
      chatInput({ commandName: 'help' }).interaction
    );

    expect(help.execute).toHaveBeenCalledTimes(1);
    expect(ping.execute).not.toHaveBeenCalled();
  });

  it('does not settle until the command has finished executing', async () => {
    let finish!: () => void;
    const ping = command();
    ping.execute.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve))
    );
    let settled = false;

    const routing = routeInteraction(
      clientWith(ping),
      chatInput().interaction
    ).then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(ping.execute).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(metrics.getSnapshot().commands.executed).toBe(0);

    finish();
    await routing;

    expect(settled).toBe(true);
    expect(metrics.getSnapshot().commands.executed).toBe(1);
  });

  it('records a successful execution in metrics', async () => {
    await routeInteraction(clientWith(command()), chatInput().interaction);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.commands.executed).toBe(1);
    expect(snapshot.commands.errors).toBe(0);
    expect(snapshot.commands.byName).toEqual({ ping: 1 });
  });

  it('does not execute when middleware blocks, and leaves the reply to the middleware', async () => {
    vi.mocked(runMiddleware).mockResolvedValueOnce(false);
    const ping = command();
    const stub = chatInput();

    await routeInteraction(clientWith(ping), stub.interaction);

    expect(ping.execute).not.toHaveBeenCalled();
    expect(responsesSent(stub)).toBe(0);
    expect(metrics.getSnapshot().commands.executed).toBe(0);
  });

  it('blocks a command the member lacks permissions for (real permissions middleware)', async () => {
    const ban = command({
      name: 'ban',
      middleware: ['permissions'],
      options: { permissions: [PermissionFlagsBits.BanMembers] },
    });
    const stub = chatInput({ commandName: 'ban', permissions: [] });

    await routeInteraction(clientWith(ban), stub.interaction);

    expect(ban.execute).not.toHaveBeenCalled();
    expect(stub.reply).toHaveBeenCalledTimes(1);
    expect(stub.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
    expect(embedOf(stub.reply)).toMatchObject({
      title: t('common.commandBlocked', 'en'),
      description: t('common.permissionsRequired', 'en', {
        permissions: 'BanMembers',
      }),
    });
  });

  it('runs a permitted command (real permissions middleware)', async () => {
    const ban = command({
      name: 'ban',
      middleware: ['permissions'],
      options: { permissions: [PermissionFlagsBits.BanMembers] },
    });
    const stub = chatInput({
      commandName: 'ban',
      permissions: [PermissionFlagsBits.BanMembers],
    });

    await routeInteraction(clientWith(ban), stub.interaction);

    expect(ban.execute).toHaveBeenCalledTimes(1);
    expect(responsesSent(stub)).toBe(0);
  });

  describe('unknown command', () => {
    it('replies once, ephemerally, naming the missing command', async () => {
      const stub = chatInput({ commandName: 'ghost' });

      await routeInteraction(clientWith(command()), stub.interaction);

      expect(stub.reply).toHaveBeenCalledTimes(1);
      expect(responsesSent(stub)).toBe(1);
      expect(stub.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
      expect(embedOf(stub.reply)).toMatchObject({
        title: t('help.commandNotFound', 'en'),
        description: t('help.commandNotFoundDesc', 'en', { command: 'ghost' }),
        color: COLORS.ERROR,
      });
      expect(runMiddleware).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Unknown command: ghost');
    });

    it('answers in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const stub = chatInput({ commandName: 'ghost' });

      await routeInteraction(clientWith(), stub.interaction);

      expect(resolveLocale).toHaveBeenCalledWith(stub.interaction);
      expect(embedOf(stub.reply).title).toBe(t('help.commandNotFound', 'ja'));
    });

    it('swallows a failed reply', async () => {
      const stub = chatInput({
        commandName: 'ghost',
        reply: vi.fn().mockRejectedValue(new Error('Unknown interaction')),
      });

      await expect(
        routeInteraction(clientWith(), stub.interaction)
      ).resolves.toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to reply unknown command: Unknown interaction'
      );
    });
  });

  describe('when the command throws', () => {
    it.each<Locale>(['en', 'ja'])(
      'replies once with an ephemeral error embed (%s)',
      async (locale) => {
        resolveLocale.mockReturnValue(locale);
        const ping = command();
        ping.execute.mockRejectedValue(new Error('boom'));
        const stub = chatInput();

        await routeInteraction(clientWith(ping), stub.interaction);

        expect(stub.reply).toHaveBeenCalledTimes(1);
        expect(responsesSent(stub)).toBe(1);
        expect(stub.reply.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
        expect(embedOf(stub.reply)).toMatchObject({
          title: t('common.error', locale),
          description: t('common.unexpectedError', locale),
          color: COLORS.ERROR,
        });
      }
    );

    it('edits the deferred reply instead of replying again', async () => {
      const ping = command();
      const stub = chatInput();
      ping.execute.mockImplementation(async (interaction) => {
        interaction.deferred = true; // what deferReply() does
        throw new Error('boom after defer');
      });

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(stub.reply).not.toHaveBeenCalled();
      expect(stub.editReply).toHaveBeenCalledTimes(1);
      expect(responsesSent(stub)).toBe(1);
      expect(stub.editReply.mock.calls[0][0]).not.toHaveProperty('flags');
      expect(embedOf(stub.editReply).title).toBe(t('common.error', 'en'));
    });

    it('edits the existing reply when the command already replied', async () => {
      const ping = command();
      const stub = chatInput();
      ping.execute.mockImplementation(async (interaction) => {
        interaction.replied = true; // what reply() does
        throw new Error('boom after reply');
      });

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(stub.reply).not.toHaveBeenCalled();
      expect(stub.editReply).toHaveBeenCalledTimes(1);
      expect(responsesSent(stub)).toBe(1);
      expect(embedOf(stub.editReply).description).toBe(
        t('common.unexpectedError', 'en')
      );
    });

    it('records the error in metrics and the log, not as a success', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));

      await routeInteraction(clientWith(ping), chatInput().interaction);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.executed).toBe(0);
      expect(snapshot.commands.errors).toBe(1);
      expect(snapshot.commands.byName).toEqual({ 'ping:error': 1 });
      expect(logger.error).toHaveBeenCalledWith(
        'Error executing command ping:',
        'boom'
      );
    });

    it('swallows a failed error reply', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));
      const stub = chatInput({
        reply: vi.fn().mockRejectedValue(new Error('Unknown interaction')),
      });

      await expect(
        routeInteraction(clientWith(ping), stub.interaction)
      ).resolves.toBeUndefined();
      expect(stub.reply).toHaveBeenCalledTimes(1);
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to reply with error embed: Unknown interaction'
      );
    });

    it('swallows a failed error edit', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));
      const stub = chatInput({
        deferred: true,
        editReply: vi.fn().mockRejectedValue(new Error('Unknown Message')),
      });

      await expect(
        routeInteraction(clientWith(ping), stub.interaction)
      ).resolves.toBeUndefined();
      expect(stub.editReply).toHaveBeenCalledTimes(1);
      expect(stub.reply).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to edit reply with error embed: Unknown Message'
      );
    });

    it('treats a middleware crash like a command failure', async () => {
      vi.mocked(runMiddleware).mockRejectedValueOnce(new Error('db down'));
      const ping = command();
      const stub = chatInput();

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(ping.execute).not.toHaveBeenCalled();
      expect(stub.reply).toHaveBeenCalledTimes(1);
      expect(embedOf(stub.reply).title).toBe(t('common.error', 'en'));
      expect(metrics.getSnapshot().commands.errors).toBe(1);
    });

    it('does not touch cooldowns for commands without the cooldown middleware', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));

      await routeInteraction(clientWith(ping), chatInput().interaction);

      expect(clearCooldown).not.toHaveBeenCalled();
    });
  });

  describe('cooldowns (real cooldown middleware and store)', () => {
    const NOW = new Date('2026-01-01T00:00:00Z').getTime();

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    function slow() {
      return command({
        name: 'slow',
        middleware: ['cooldown'],
        options: { cooldown: 5_000 },
      });
    }

    it('blocks a repeat use inside the window and allows it once it expires', async () => {
      const cmd = slow();
      const client = clientWith(cmd);

      await routeInteraction(
        client,
        chatInput({ commandName: 'slow' }).interaction
      );
      expect(cmd.execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      const blocked = chatInput({ commandName: 'slow' });
      await routeInteraction(client, blocked.interaction);

      expect(cmd.execute).toHaveBeenCalledTimes(1);
      expect(blocked.reply).toHaveBeenCalledTimes(1);
      expect(embedOf(blocked.reply)).toMatchObject({
        title: t('common.commandBlocked', 'en'),
        description: t('common.cooldown', 'en', {
          time: '3.0',
          command: 'slow',
        }),
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await routeInteraction(
        client,
        chatInput({ commandName: 'slow' }).interaction
      );

      expect(cmd.execute).toHaveBeenCalledTimes(2);
    });

    it('refunds the cooldown when the command fails so the user can retry at once', async () => {
      const cmd = slow();
      cmd.execute.mockRejectedValueOnce(new Error('transient'));
      const client = clientWith(cmd);

      await routeInteraction(
        client,
        chatInput({ commandName: 'slow' }).interaction
      );

      expect(clearCooldown).toHaveBeenCalledWith('slow', USER_ID);
      expect(cooldownStore.isOnCooldown('slow', USER_ID)).toBe(false);

      const retry = chatInput({ commandName: 'slow' });
      await routeInteraction(client, retry.interaction);

      expect(cmd.execute).toHaveBeenCalledTimes(2);
      expect(responsesSent(retry)).toBe(0);
    });
  });
});

describe('routeInteraction: autocomplete', () => {
  it('delegates to the command autocomplete handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const search = command({ name: 'search', autocomplete: handler });
    const { interaction, respond } = autocomplete('search');

    await routeInteraction(clientWith(search), interaction);

    expect(handler).toHaveBeenCalledWith(interaction);
    expect(respond).not.toHaveBeenCalled();
    expect(search.execute).not.toHaveBeenCalled();
    expect(runMiddleware).not.toHaveBeenCalled();
  });

  it('does not settle until the autocomplete handler has answered', async () => {
    let answer!: () => void;
    const handler = vi.fn(
      () => new Promise<void>((resolve) => (answer = resolve))
    );
    const search = command({ name: 'search', autocomplete: handler });
    const { interaction, respond } = autocomplete('search');
    let settled = false;

    const routing = routeInteraction(clientWith(search), interaction).then(
      () => {
        settled = true;
      }
    );
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    answer();
    await routing;

    expect(settled).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });

  it('responds with no choices when the command is unknown', async () => {
    const { interaction, respond } = autocomplete('ghost');

    await routeInteraction(clientWith(), interaction);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('responds with no choices when the command has no autocomplete handler', async () => {
    const search = command({ name: 'search' });
    const { interaction, respond } = autocomplete('search');

    await routeInteraction(clientWith(search), interaction);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith([]);
    expect(search.execute).not.toHaveBeenCalled();
    // A missing handler is normal, not a crash: calling `undefined` and
    // catching the TypeError would answer the same but log an error on every
    // keystroke.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to no choices when the handler throws', async () => {
    const search = command({
      name: 'search',
      autocomplete: vi.fn().mockRejectedValue(new Error('lookup failed')),
    });
    const { interaction, respond } = autocomplete('search');

    await routeInteraction(clientWith(search), interaction);

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Autocomplete error for search:',
      'lookup failed'
    );
  });

  it('swallows a failed fallback response after a handler error', async () => {
    const search = command({
      name: 'search',
      autocomplete: vi.fn().mockRejectedValue(new Error('lookup failed')),
    });
    const { interaction } = autocomplete(
      'search',
      vi.fn().mockRejectedValue(new Error('already responded'))
    );

    await expect(
      routeInteraction(clientWith(search), interaction)
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to respond to autocomplete error: already responded'
    );
  });

  it('swallows a failed empty response for an unknown command', async () => {
    const { interaction } = autocomplete(
      'ghost',
      vi.fn().mockRejectedValue(new Error('expired'))
    );

    await expect(
      routeInteraction(clientWith(), interaction)
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to respond to autocomplete: expired'
    );
  });
});

describe('routeInteraction: other interaction types', () => {
  /**
   * Buttons, selects and modals are not routed here: each panel or dialog
   * awaits its own components on the message it sent (customId-scoped
   * collectors). The router must leave them untouched so it never answers an
   * interaction a collector is about to handle.
   */
  function responders() {
    return {
      reply: vi.fn(),
      editReply: vi.fn(),
      update: vi.fn(),
      deferUpdate: vi.fn(),
      deferReply: vi.fn(),
      showModal: vi.fn(),
      respond: vi.fn(),
    };
  }

  const cases: [string, () => Interaction & Record<string, Mock>][] = [
    [
      'button',
      () =>
        onPrototype(ButtonInteraction.prototype, {
          type: InteractionType.MessageComponent,
          componentType: ComponentType.Button,
          customId: 'confirm_123',
          ...responders(),
        }),
    ],
    [
      'string select',
      () =>
        onPrototype(StringSelectMenuInteraction.prototype, {
          type: InteractionType.MessageComponent,
          componentType: ComponentType.StringSelect,
          customId: 'settings:language',
          values: ['ja'],
          ...responders(),
        }),
    ],
    [
      'modal submit',
      () =>
        onPrototype(ModalSubmitInteraction.prototype, {
          type: InteractionType.ModalSubmit,
          customId: 'ping:modal',
          ...responders(),
        }),
    ],
    [
      'user context menu named like a slash command',
      () =>
        onPrototype(UserContextMenuCommandInteraction.prototype, {
          type: InteractionType.ApplicationCommand,
          commandType: ApplicationCommandType.User,
          commandName: 'ping',
          ...responders(),
        }),
    ],
  ];

  it.each(cases)('ignores a %s interaction', async (_label, build) => {
    const ping = command({ name: 'ping', autocomplete: vi.fn() });
    const interaction = build();

    await routeInteraction(clientWith(ping), interaction);

    expect(ping.execute).not.toHaveBeenCalled();
    expect(ping.autocomplete).not.toHaveBeenCalled();
    expect(runMiddleware).not.toHaveBeenCalled();
    for (const name of Object.keys(responders())) {
      expect(interaction[name]).not.toHaveBeenCalled();
    }
  });
});
