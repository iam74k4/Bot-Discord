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
  UserContextMenuCommandInteraction,
  type EmbedBuilder,
  type Interaction,
} from 'discord.js';
import { performance } from 'node:perf_hooks';
import type { ExtendedClient } from '../../../client.js';
import type { Command } from '../../../shared/types/index.js';
import { COMPONENT_GRACE_MS, routeInteraction } from '../interactionRouter.js';
import { releaseCooldown, runMiddleware } from '../../../middleware/index.js';
import { cooldownStore } from '../../../middleware/cooldown/cooldownStore.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import {
  clearComponentHandlers,
  clearLiveComponents,
  registerComponentHandler,
  setComponentRoutingReady,
  SETTLED_COMPONENT_MEMORY_MS,
  trackLiveComponents,
} from '../../../shared/interactions/index.js';
import {
  clearCommandIds,
  setCommandIds,
} from '../../../shared/utils/commandMentions.js';

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
    releaseCooldown: vi.fn(actual.releaseCooldown),
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
    subcommand?: string;
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
      id: '1300000000000000000',
      commandName: options.commandName ?? 'ping',
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => options.subcommand ?? null,
      },
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

/** The error id an unexpected-error embed shows, checked against the log. */
function errorIdIn(description: string | undefined): string {
  const id = /`([0-9a-f]{6})`/.exec(description ?? '')?.[1];
  expect(id, `no error id in: ${description}`).toBeDefined();
  return id!;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
  metrics.reset();
  cooldownStore.clearAll();
});

afterEach(() => {
  cooldownStore.clearAll();
  clearComponentHandlers();
  clearLiveComponents();
  clearCommandIds();
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
      title: t('common.permissionDeniedTitle', 'en'),
      description: t('common.permissionsRequired', 'en', {
        permissions: 'Ban Members',
      }),
      color: COLORS.WARNING,
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
        const embed = embedOf(stub.reply);
        const id = errorIdIn(embed.description);
        expect(embed).toMatchObject({
          title: t('common.error', locale),
          description: t('common.unexpectedError', locale, { id }),
          color: COLORS.ERROR,
        });
      }
    );

    it('logs the same error id it shows, with the stack', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));
      const stub = chatInput();

      await routeInteraction(clientWith(ping), stub.interaction);

      const id = errorIdIn(embedOf(stub.reply).description);
      expect(logger.error).toHaveBeenCalledWith(
        `[${id}] Error executing command ping:`,
        expect.stringMatching(/^Error: boom\n\s+at /)
      );
    });

    it('gives each failure its own id', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));
      const first = chatInput();
      const second = chatInput();

      await routeInteraction(clientWith(ping), first.interaction);
      await routeInteraction(clientWith(ping), second.interaction);

      expect(errorIdIn(embedOf(first.reply).description)).not.toBe(
        errorIdIn(embedOf(second.reply).description)
      );
    });

    it('names the full subcommand path in the log', async () => {
      const voice = command({ name: 'voice' });
      voice.execute.mockRejectedValue(new Error('boom'));

      await routeInteraction(
        clientWith(voice),
        chatInput({ commandName: 'voice', subcommand: 'record' }).interaction
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[[0-9a-f]{6}\] Error executing command voice record:$/
        ),
        expect.any(String)
      );
    });

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

    it('edits the existing private reply when the command already replied', async () => {
      const ping = command();
      const stub = chatInput();
      ping.execute.mockImplementation(async (interaction) => {
        interaction.replied = true; // what reply() does
        interaction.ephemeral = true;
        throw new Error('boom after reply');
      });

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(stub.reply).not.toHaveBeenCalled();
      expect(stub.editReply).toHaveBeenCalledTimes(1);
      expect(responsesSent(stub)).toBe(1);
      const description = embedOf(stub.editReply).description;
      expect(description).toBe(
        t('common.unexpectedError', 'en', { id: errorIdIn(description) })
      );
    });

    it('keeps a public result in place and apologises privately beside it', async () => {
      const ping = command();
      const stub = chatInput();
      ping.execute.mockImplementation(async (interaction) => {
        interaction.deferred = true; // a public deferReply()
        interaction.ephemeral = false;
        interaction.replied = true; // ...then editReply() posted the result
        throw new Error('boom mid-animation');
      });

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(stub.editReply).not.toHaveBeenCalled();
      expect(stub.followUp).toHaveBeenCalledTimes(1);
      expect(stub.followUp.mock.calls[0][0].flags).toBe(MessageFlags.Ephemeral);
      expect(embedOf(stub.followUp).title).toBe(t('common.error', 'en'));
    });

    it('replaces a public "thinking..." that never got a result', async () => {
      const ping = command();
      const stub = chatInput();
      ping.execute.mockImplementation(async (interaction) => {
        interaction.deferred = true;
        interaction.ephemeral = false;
        throw new Error('boom while thinking');
      });

      await routeInteraction(clientWith(ping), stub.interaction);

      expect(stub.followUp).not.toHaveBeenCalled();
      expect(stub.editReply).toHaveBeenCalledTimes(1);
    });

    it('records the error in metrics and the log, not as a success', async () => {
      const ping = command();
      ping.execute.mockRejectedValue(new Error('boom'));

      await routeInteraction(clientWith(ping), chatInput().interaction);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.commands.executed).toBe(0);
      expect(snapshot.commands.errors).toBe(1);
      expect(snapshot.commands.byName).toEqual({ 'ping:error': 1 });
      expect(logger.error).toHaveBeenCalledTimes(1);
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

      expect(releaseCooldown).not.toHaveBeenCalled();
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
        title: t('common.cooldownTitle', 'en'),
        description: t('common.cooldown', 'en', {
          seconds: 3,
          command: '`/slow`',
        }),
        color: COLORS.WARNING,
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

      expect(cooldownStore.isOnCooldown('slow', USER_ID)).toBe(false);

      const retry = chatInput({ commandName: 'slow' });
      await routeInteraction(client, retry.interaction);

      expect(cmd.execute).toHaveBeenCalledTimes(2);
      expect(responsesSent(retry)).toBe(0);
    });

    it('keeps sibling subcommands apart and refunds only the failed path', async () => {
      const voice = command({
        name: 'voice',
        middleware: ['cooldown'],
        options: { cooldown: 10_000 },
      });
      const client = clientWith(voice);
      voice.execute.mockImplementationOnce(async () => undefined);
      voice.execute.mockRejectedValueOnce(new Error('transient'));

      await routeInteraction(
        client,
        chatInput({ commandName: 'voice', subcommand: 'status' }).interaction
      );
      await routeInteraction(
        client,
        chatInput({ commandName: 'voice', subcommand: 'record' }).interaction
      );

      // status ran and keeps its cooldown; record failed and was refunded.
      expect(voice.execute).toHaveBeenCalledTimes(2);
      expect(cooldownStore.isOnCooldown('voice status', USER_ID)).toBe(true);
      expect(cooldownStore.isOnCooldown('voice record', USER_ID)).toBe(false);
    });

    it('lets a handler hand back its cooldown after turning the request down', async () => {
      const cmd = slow();
      cmd.execute.mockImplementationOnce(async (interaction) => {
        // e.g. "join a voice channel first"
        await interaction.reply({ content: 'join a VC first' });
        releaseCooldown(interaction);
      });
      const client = clientWith(cmd);

      await routeInteraction(
        client,
        chatInput({ commandName: 'slow' }).interaction
      );
      const retry = chatInput({ commandName: 'slow' });
      await routeInteraction(client, retry.interaction);

      expect(cmd.execute).toHaveBeenCalledTimes(2);
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

describe('routeInteraction: buttons and selects', () => {
  const MESSAGE_ID = 'message-1';

  interface ComponentStub {
    interaction: ButtonInteraction;
    update: Mock;
    reply: Mock;
    followUp: Mock;
    deferUpdate: Mock;
  }

  function row() {
    return {
      toJSON: () => ({
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, custom_id: 'a', style: 1, label: 'A' },
          { type: ComponentType.Button, custom_id: 'b', style: 2, label: 'B' },
        ],
      }),
    };
  }

  function button(
    options: {
      customId?: string;
      createdTimestamp?: number;
      origin?: string | null;
      originType?: InteractionType;
      components?: unknown[];
      update?: Mock;
    } = {}
  ): ComponentStub {
    const update = options.update ?? vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const interaction = onPrototype<ButtonInteraction>(
      ButtonInteraction.prototype,
      {
        id: '1300000000000000001',
        type: InteractionType.MessageComponent,
        componentType: ComponentType.Button,
        customId: options.customId ?? 'settings-panel:audit',
        user: { id: USER_ID },
        guildId: 'guild-1',
        locale: 'en-US',
        replied: false,
        deferred: false,
        message: {
          id: MESSAGE_ID,
          createdTimestamp: options.createdTimestamp ?? Date.now(),
          components: options.components ?? [row()],
          interaction:
            options.origin === null
              ? null
              : {
                  type:
                    options.originType ?? InteractionType.ApplicationCommand,
                  commandName: options.origin ?? 'admin settings view',
                },
        },
        update,
        reply,
        followUp,
        deferUpdate,
      }
    );
    return { interaction, update, reply, followUp, deferUpdate };
  }

  function answers(stub: ComponentStub): number {
    return (
      stub.update.mock.calls.length +
      stub.reply.mock.calls.length +
      stub.followUp.mock.calls.length +
      stub.deferUpdate.mock.calls.length
    );
  }

  const beforeBoot = () => performance.timeOrigin - 60_000;

  beforeEach(() => {
    // Every feature has started; the startup window has its own block below.
    setComponentRoutingReady(true);
  });

  it('leaves a message with a live collector to that collector', async () => {
    vi.useFakeTimers();
    trackLiveComponents(MESSAGE_ID);
    const handle = vi.fn();
    registerComponentHandler('settings-panel:', handle);
    const stub = button({ createdTimestamp: beforeBoot() });

    const routing = routeInteraction(clientWith(), stub.interaction);
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS * 2);
    await routing;

    expect(answers(stub)).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  describe('persistent handlers', () => {
    it('dispatches by customId prefix, also on messages from before a restart', async () => {
      const handle = vi.fn().mockResolvedValue(undefined);
      registerComponentHandler('voice-optout:', handle);
      const stub = button({
        customId: 'voice-optout:123',
        createdTimestamp: beforeBoot(),
      });

      await routeInteraction(clientWith(), stub.interaction);

      expect(handle).toHaveBeenCalledWith(stub.interaction);
      expect(answers(stub)).toBe(0);
    });

    it('reports a failing handler privately, with the logged error id', async () => {
      registerComponentHandler(
        'voice-optout:',
        vi.fn().mockRejectedValue(new Error('db down'))
      );
      const stub = button({ customId: 'voice-optout:123' });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.reply).toHaveBeenCalledTimes(1);
      const payload = stub.reply.mock.calls[0][0];
      expect(payload.flags).toBe(MessageFlags.Ephemeral);
      const id = errorIdIn(payload.content);
      expect(payload.content).toBe(t('common.actionFailed', 'en', { id }));
      expect(logger.error).toHaveBeenCalledWith(
        `[${id}] Component handler voice-optout: failed:`,
        expect.stringContaining('db down')
      );
    });

    it('follows up instead when the failing handler had already answered', async () => {
      registerComponentHandler('voice-optout:', async (interaction) => {
        interaction.deferred = true;
        throw new Error('after defer');
      });
      const stub = button({ customId: 'voice-optout:123' });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.reply).not.toHaveBeenCalled();
      expect(stub.followUp).toHaveBeenCalledTimes(1);
    });
  });

  describe('components nothing answers', () => {
    it('answers a message from before this process started at once', async () => {
      setCommandIds([{ name: 'admin', id: '42' }]);
      const stub = button({ createdTimestamp: beforeBoot() });

      await routeInteraction(clientWith(), stub.interaction);

      // Greyed out for everyone...
      expect(stub.update).toHaveBeenCalledTimes(1);
      const rows = stub.update.mock.calls[0][0].components;
      expect(rows).toHaveLength(1);
      expect(
        rows[0].components.map((c: { disabled: boolean }) => c.disabled)
      ).toEqual([true, true]);
      expect(rows[0].components[0]).toMatchObject({
        custom_id: 'a',
        label: 'A',
      });
      // ...and the clicker is told what to run again.
      expect(stub.followUp).toHaveBeenCalledWith({
        content: t('common.componentExpired', 'en', {
          command: '</admin settings view:42>',
        }),
        flags: MessageFlags.Ephemeral,
      });
    });

    it('waits for anything else to answer a recent message before stepping in', async () => {
      vi.useFakeTimers();
      const stub = button();
      let settled = false;

      const routing = routeInteraction(clientWith(), stub.interaction).then(
        () => {
          settled = true;
        }
      );
      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS - 1);
      expect(answers(stub)).toBe(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await routing;
      expect(stub.update).toHaveBeenCalledTimes(1);
      expect(stub.followUp).toHaveBeenCalledTimes(1);
    });

    it('stays silent when something else acknowledged the click in time', async () => {
      vi.useFakeTimers();
      const stub = button();

      const routing = routeInteraction(clientWith(), stub.interaction);
      await vi.advanceTimersByTimeAsync(500);
      stub.interaction.deferred = true; // an untracked collector answered
      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS);
      await routing;

      expect(answers(stub)).toBe(0);
    });

    it('uses generic wording when the message replied to a button press, not a command', async () => {
      // Discord names a component reply after the button's customId.
      const stub = button({
        createdTimestamp: beforeBoot(),
        origin: 'admin-panel:backup',
        originType: InteractionType.MessageComponent,
      });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.followUp).toHaveBeenCalledWith({
        content: t('common.componentExpiredGeneric', 'en'),
        flags: MessageFlags.Ephemeral,
      });
    });

    it('uses generic wording when the message came from no command', async () => {
      const stub = button({ createdTimestamp: beforeBoot(), origin: null });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.followUp).toHaveBeenCalledWith({
        content: t('common.componentExpiredGeneric', 'en'),
        flags: MessageFlags.Ephemeral,
      });
    });

    it('replies privately without editing a message that is not plain rows', async () => {
      const stub = button({
        createdTimestamp: beforeBoot(),
        components: [{ toJSON: () => ({ type: ComponentType.Container }) }],
      });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.update).not.toHaveBeenCalled();
      expect(stub.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral })
      );
    });

    it('falls back to a private reply when the message cannot be edited', async () => {
      const stub = button({
        createdTimestamp: beforeBoot(),
        update: vi.fn().mockRejectedValue(new Error('Unknown Message')),
      });

      await expect(
        routeInteraction(clientWith(), stub.interaction)
      ).resolves.toBeUndefined();

      expect(stub.reply).toHaveBeenCalledTimes(1);
      expect(stub.reply.mock.calls[0][0].content).toBe(
        t('common.componentExpired', 'en', {
          command: '`/admin settings view`',
        })
      );
    });

    it('answers in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const stub = button({ createdTimestamp: beforeBoot() });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.followUp.mock.calls[0][0].content).toBe(
        t('common.componentExpired', 'ja', {
          command: '`/admin settings view`',
        })
      );
    });
  });

  describe('a panel or prompt that has just settled', () => {
    /** A collector that ran on MESSAGE_ID and has just ended. */
    function settle(): void {
      trackLiveComponents(MESSAGE_ID)();
    }

    it('acknowledges a late click at once, without touching the message', async () => {
      vi.useFakeTimers();
      settle();
      const stub = button();

      const routing = routeInteraction(clientWith(), stub.interaction);
      // No grace wait: nothing else will answer, and the owner is editing.
      await flushMicrotasks();
      expect(stub.deferUpdate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS);
      await routing;
      expect(answers(stub)).toBe(1);
    });

    it('acknowledges quietly when the collector settles during the grace wait', async () => {
      vi.useFakeTimers();
      const stub = button();

      const routing = routeInteraction(clientWith(), stub.interaction);
      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS / 2);
      settle(); // e.g. the panel's idle timer fired just now
      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS);
      await routing;

      expect(stub.deferUpdate).toHaveBeenCalledTimes(1);
      expect(answers(stub)).toBe(1);
    });

    it('treats the message as expired again once the memory has passed', async () => {
      vi.useFakeTimers();
      settle();
      vi.advanceTimersByTime(SETTLED_COMPONENT_MEMORY_MS);
      const stub = button({ createdTimestamp: beforeBoot() });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.deferUpdate).not.toHaveBeenCalled();
      expect(stub.update).toHaveBeenCalledTimes(1);
      expect(stub.followUp).toHaveBeenCalledTimes(1);
    });

    it('still leaves the message to a collector that opened on it again', async () => {
      settle();
      trackLiveComponents(MESSAGE_ID);
      const stub = button({ createdTimestamp: beforeBoot() });

      await routeInteraction(clientWith(), stub.interaction);

      expect(answers(stub)).toBe(0);
    });
  });

  describe('while features are starting or stopping', () => {
    beforeEach(() => {
      setComponentRoutingReady(false);
    });

    it('asks the user to retry and leaves a message from before the restart untouched', async () => {
      // e.g. a persistent button whose feature has not registered yet
      const stub = button({
        customId: 'voice-optout:123',
        createdTimestamp: beforeBoot(),
      });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.update).not.toHaveBeenCalled();
      expect(stub.followUp).not.toHaveBeenCalled();
      expect(stub.reply).toHaveBeenCalledTimes(1);
      expect(stub.reply).toHaveBeenCalledWith({
        content: t('common.componentNotReady', 'en'),
        flags: MessageFlags.Ephemeral,
      });
    });

    it('routes the button normally once its feature has registered', async () => {
      const handle = vi.fn().mockResolvedValue(undefined);
      registerComponentHandler('voice-optout:', handle);
      const stub = button({
        customId: 'voice-optout:123',
        createdTimestamp: beforeBoot(),
      });

      await routeInteraction(clientWith(), stub.interaction);

      expect(handle).toHaveBeenCalledWith(stub.interaction);
      expect(answers(stub)).toBe(0);
    });

    it('still gives a recent message the grace period during shutdown', async () => {
      vi.useFakeTimers();
      const stub = button();

      const routing = routeInteraction(clientWith(), stub.interaction);
      await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS - 1);
      expect(answers(stub)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await routing;

      expect(stub.update).not.toHaveBeenCalled();
      expect(stub.reply).toHaveBeenCalledWith({
        content: t('common.componentNotReady', 'en'),
        flags: MessageFlags.Ephemeral,
      });
    });

    it('swallows a failed retry note', async () => {
      const stub = button({ createdTimestamp: beforeBoot() });
      stub.reply.mockRejectedValue(new Error('Unknown interaction'));

      await expect(
        routeInteraction(clientWith(), stub.interaction)
      ).resolves.toBeUndefined();
      expect(stub.update).not.toHaveBeenCalled();
    });

    it('answers in the resolved locale', async () => {
      resolveLocale.mockReturnValue('ja');
      const stub = button({ createdTimestamp: beforeBoot() });

      await routeInteraction(clientWith(), stub.interaction);

      expect(stub.reply.mock.calls[0][0].content).toBe(
        t('common.componentNotReady', 'ja')
      );
    });
  });
});

describe('routeInteraction: submitted forms', () => {
  function modalSubmit(fields: Record<string, unknown> = {}) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = onPrototype<ModalSubmitInteraction>(
      ModalSubmitInteraction.prototype,
      {
        id: '1300000000000000005',
        type: InteractionType.ModalSubmit,
        customId: 'poll-create:1300000000000000004',
        user: { id: USER_ID },
        locale: 'en-US',
        replied: false,
        deferred: false,
        reply,
        ...fields,
      }
    );
    return { interaction, reply };
  }

  it('leaves a form to whoever opened it, when they answer in time', async () => {
    vi.useFakeTimers();
    const { interaction, reply } = modalSubmit();

    const routing = routeInteraction(clientWith(), interaction);
    // The opener's awaitModalSubmit answers it within the grace period.
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS - 1);
    Object.assign(interaction, { replied: true });
    await vi.advanceTimersByTimeAsync(1);
    await routing;

    expect(reply).not.toHaveBeenCalled();
  });

  it('tells the user a form nobody is waiting for was not saved', async () => {
    vi.useFakeTimers();
    const { interaction, reply } = modalSubmit();

    const routing = routeInteraction(clientWith(), interaction);
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS - 1);
    expect(reply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await routing;

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: t('common.formExpired', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('stays silent when the opener deferred the submission', async () => {
    vi.useFakeTimers();
    const { interaction, reply } = modalSubmit({ deferred: true });

    const routing = routeInteraction(clientWith(), interaction);
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS);
    await routing;

    expect(reply).not.toHaveBeenCalled();
  });

  it('answers in the resolved locale and swallows a failed reply', async () => {
    vi.useFakeTimers();
    resolveLocale.mockReturnValue('ja');
    const { interaction, reply } = modalSubmit();
    reply.mockRejectedValueOnce(new Error('Unknown interaction'));

    const routing = routeInteraction(clientWith(), interaction);
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS);

    await expect(routing).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledWith({
      content: t('common.formExpired', 'ja'),
      flags: MessageFlags.Ephemeral,
    });
  });
});

describe('routeInteraction: other interaction types', () => {
  /** Context menus are owned by whoever registered them. */
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
    vi.useFakeTimers();
    const ping = command({ name: 'ping', autocomplete: vi.fn() });
    const interaction = build();

    const routing = routeInteraction(clientWith(ping), interaction);
    await vi.advanceTimersByTimeAsync(COMPONENT_GRACE_MS * 2);
    await routing;

    expect(ping.execute).not.toHaveBeenCalled();
    expect(ping.autocomplete).not.toHaveBeenCalled();
    expect(runMiddleware).not.toHaveBeenCalled();
    for (const name of Object.keys(responders())) {
      expect(interaction[name]).not.toHaveBeenCalled();
    }
  });
});

describe('routeInteraction: time-to-acknowledge labels', () => {
  it('labels a slash command by its full path for the acknowledgement metric', async () => {
    const voice = command({ name: 'voice' });
    const stub = chatInput({ commandName: 'voice', subcommand: 'record' });

    await routeInteraction(clientWith(voice), stub.interaction);
    metrics.recordAcknowledgement(stub.interaction.id, true);

    expect(
      metrics.getAcknowledgementStats().slowest.map((s) => s.label)
    ).toEqual(['voice record']);
  });

  it('labels components by their customId family', async () => {
    trackLiveComponents('message-1');
    const interaction = onPrototype<ButtonInteraction>(
      ButtonInteraction.prototype,
      {
        id: '1300000000000000002',
        type: InteractionType.MessageComponent,
        componentType: ComponentType.Button,
        customId: 'settings-panel:audit',
        message: { id: 'message-1', createdTimestamp: Date.now() },
      }
    );

    await routeInteraction(clientWith(), interaction);
    metrics.recordAcknowledgement(interaction.id, true);

    expect(metrics.getAcknowledgementStats().slowest[0].label).toBe(
      'component:settings-panel'
    );
  });
});
