import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * Runs every slash command path the registry discovers against the real
 * application code, so a command added under `src/features/<f>/commands/`
 * is smoke-tested with no change to this file (beyond declaring who may use
 * it in `COMMAND_POLICY`, which one test insists on).
 *
 * Only true externals are replaced: the database is in-memory SQLite brought
 * up by the real migration runner, voice connections and the recorder are
 * fakes, and backups never touch the disk. Everything between the
 * interaction and those seams - option parsing (discord.js's own resolver),
 * middleware, permission checks, repositories, panels, confirmations, audit
 * logging - is the production code.
 *
 * For each path the invariants are the ones Discord and users care about:
 * the command resolves, acknowledges the interaction exactly once, never
 * edits before acknowledging, logs no error, reads only options it
 * declares, sends nothing Discord would reject, and shows no raw translation
 * key or unfilled `{placeholder}`. In a fully set-up server it must also
 * reach a non-error response, with ordinary values and at the limits of every
 * option. On top of that:
 * - who is served or refused follows the declared policy, not whatever the
 *   code currently enforces (and `/general help` shows exactly that);
 * - every path either proves it did its work (`REACHES`) or proves it
 *   changed nothing (`READ_ONLY`);
 * - cooldowns refuse a repeat for exactly as long as declared;
 * - a Discord failure mid-command is answered privately by the router.
 * A path that only succeeds with some prior state (something to remove, a
 * poll to end) gets it from `SCENARIOS`.
 */

const { db } = await vi.hoisted(async () => {
  const { default: Database } = await import('better-sqlite3');
  return { db: new Database(':memory:') };
});

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

/** Stand-in for the voice connection manager: one buffered channel. */
const voice = vi.hoisted(() => {
  const connections = new Map<
    string,
    { channelId: string; guildId: string; connectedAt: number }
  >();
  return {
    connections,
    manager: {
      getConnection: vi.fn((channelId: string) => connections.get(channelId)),
      getAllConnections: vi.fn(() => new Map(connections)),
      getConnectionCount: vi.fn(() => connections.size),
      isAtLimit: vi.fn(() => false),
      disconnect: vi.fn(async (channelId: string) => {
        connections.delete(channelId);
      }),
    },
    recordAudio: vi.fn(async (options: { duration: number }) => ({
      filePath: `recordings/smoke-${options.duration}s.wav`,
      fileSize: 48_000,
      duration: options.duration,
      isSplit: false,
    })),
  };
});

const backup = vi.hoisted(() => ({
  runBackup: vi.fn(async () => ({
    success: true,
    filename: 'backup-smoke.db',
    size: 4096,
    timestamp: new Date(0),
  })),
  formatBackupList: vi.fn(async () => 'No backups found.'),
  listBackups: vi.fn(async () => []),
}));

vi.mock('../../../infrastructure/database/connection.js', () => ({
  database: db,
  getTableCount: () =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'"
        )
        .get() as { count: number }
    ).count,
  closeDatabase: vi.fn(),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock('../../../infrastructure/backup/index.js', () => ({
  backupService: backup,
}));

vi.mock('../../../features/voice/recording/connectionManager.js', () => ({
  connectionManager: voice.manager,
}));

vi.mock(
  '../../../features/voice/recording/recordingService.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../features/voice/recording/recordingService.js')
    >()),
    recordAudio: voice.recordAudio,
  })
);

import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type PermissionsBitField,
} from 'discord.js';
import type { Mock } from 'vitest';
import { awaitConfirmation } from '../../../shared/utils/confirm.js';
import {
  buildHelpCatalog,
  type PermissionLevel,
} from '../../../shared/help/catalog.js';
import { canUserSeeCommandWithContext } from '../../../features/general/application/help.js';
import { initializeDatabase } from '../../../infrastructure/database/migrations/index.js';
import { buildCommandCollection } from '../../../app/interactions/commandRegistry.js';
import { routeInteraction } from '../../../app/interactions/interactionRouter.js';
import { clearCooldown } from '../../../middleware/index.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { t } from '../../../locales/index.js';
import { en } from '../../../locales/en.js';
import { ja } from '../../../locales/ja.js';
import { notificationChannelRepository } from '../../../features/notification/repositories/notificationChannelRepository.js';
import { voiceSessionRepository } from '../../../features/notification/repositories/voiceSessionRepository.js';
import { pollRepository } from '../../../features/community/poll/index.js';
import { voiceSettingsRepository } from '../../../features/voice/repositories/voiceSettingsRepository.js';
import {
  COMMAND_POLICY,
  DISCORD_OPTION_BOUNDS,
  INJECTED_FAILURE,
  KNOWN_HELP_OVERREACH,
  autocompleteFor,
  commandPaths,
  createWorld,
  declaredAccess,
  effectiveCooldown,
  embedsOf,
  featuresWithCommandFiles,
  helpEntryOf,
  invalidSlashReferences,
  invokeCommand,
  leafKeys,
  loadCommands,
  messageLimitProblems,
  pathPrefixes,
  reachableFromBotDM,
  sampleOption,
  textOfLength,
  textsOf,
  translationProblems,
  type AccessLevel,
  type CommandPath,
  type Invocation,
  type LoadedCommand,
  type LooseOption,
  type OptionFill,
  type SmokeWorld,
} from './command-smoke.helpers.js';

const OWNER_ID = env.BOT_OWNER_IDS[0];
if (!OWNER_ID) {
  throw new Error('BOT_OWNER_IDS must name an owner for the /owner paths');
}

const commands = await loadCommands();
const paths = commandPaths(commands);
const KNOWN_REFERENCES = pathPrefixes(paths);
const POLL_MESSAGE_ID = '300000000000000050';

/**
 * Prior state for paths that cannot succeed from an empty server: you can
 * only remove what is there. Keyed by path label; a stale key fails the
 * "scenarios" test below.
 */
const SCENARIOS: Record<string, (world: SmokeWorld) => void> = {
  'admin role remove': (world) => {
    world.target.roles.cache.set(world.role.id, world.role);
  },
  'community poll end': (world) => {
    world.messages.set(POLL_MESSAGE_ID, {
      id: POLL_MESSAGE_ID,
      poll: {
        question: { text: 'Smoke poll?' },
        resultsFinalized: false,
        end: vi.fn().mockResolvedValue(undefined),
      },
    });
    pollRepository.create({
      message_id: POLL_MESSAGE_ID,
      guild_id: world.guild.id,
      channel_id: world.textChannel.id,
      creator_id: world.actor.id,
      expires_at: Date.now() + 60 * 60 * 1000,
    });
  },
  'notification voice disable': (world) => {
    notificationChannelRepository.set(
      world.guild.id,
      'voice',
      world.textChannel.id
    );
  },
  'notification welcome disable': (world) => {
    notificationChannelRepository.set(
      world.guild.id,
      'member_join',
      world.textChannel.id
    );
  },
  'notification stats': (world) => {
    // Forty-five minutes in the caller's voice channel, so stats have data.
    const id = voiceSessionRepository.startSession(
      world.guild.id,
      world.actor.id,
      world.voiceChannel.id,
      world.voiceChannel.name
    );
    vi.setSystemTime(Date.now() + 45 * 60 * 1000);
    voiceSessionRepository.endSession(id);
  },
  'owner system broadcast': (world) => {
    guildSettingsRepository.setAnnouncementChannel(
      world.guild.id,
      world.textChannel.id
    );
  },
  'voice autojoin enable': (world) => {
    // Auto-join defaults to on; start from off so enabling has work to do.
    voiceSettingsRepository.setAutoJoinEnabled(world.guild.id, false);
  },
  'voice autojoin include': (world) => {
    voiceSettingsRepository.addExclusion(world.guild.id, world.voiceChannel.id);
  },
};

let world: SmokeWorld;

beforeAll(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));
  vi.clearAllMocks();

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string }>;
  for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);

  world = createWorld(OWNER_ID);
  world.client.commands = buildCommandCollection(commands);
  voice.connections.clear();
  voice.connections.set(world.voiceChannel.id, {
    channelId: world.voiceChannel.id,
    guildId: world.guild.id,
    connectedAt: Date.now(),
  });
});

afterEach(() => {
  // Routed tests put the invoking user on cooldown; never let it leak.
  for (const command of commands) {
    clearCooldown(command.json.name, world.actor.id);
  }
  vi.useRealTimers();
});

/**
 * Let a command finish, running its timers (roulette animations, retries)
 * and any fire-and-forget work it started, such as audit logging.
 * Resolves to what it threw, or undefined.
 */
async function settle(work: Promise<unknown>): Promise<unknown> {
  const outcome = work.then(
    () => undefined,
    (error: unknown) => error ?? new Error('rejected without a reason')
  );
  await vi.runAllTimersAsync();
  const error = await outcome;
  await vi.runAllTimersAsync();
  return error;
}

/** The command's own first autocomplete suggestion for each such option. */
async function suggestionsFor(
  path: CommandPath
): Promise<Map<string, string | number>> {
  const suggestions = new Map<string, string | number>();
  const autocomplete = path.entry.command.autocomplete;
  if (!autocomplete) return suggestions;

  for (const option of path.options.filter((o) => o.autocomplete)) {
    const { interaction, respond } = autocompleteFor(world, path, option, '');
    await autocomplete(interaction);
    const choices = respond.mock.calls[0]?.[0] as
      | Array<{ value: string | number }>
      | undefined;
    if (choices?.[0]) suggestions.set(option.name, choices[0].value);
  }
  return suggestions;
}

/** Everything that left the bot: interaction responses and channel posts. */
function outgoing(run: Invocation): unknown[] {
  return [
    ...run.sent.map((entry) => entry.payload),
    ...world.textChannel.send.mock.calls.map((call: unknown[]) => call[0]),
  ];
}

function errorEmbeds(run: Invocation): APIEmbed[] {
  return run.sent
    .flatMap((entry) => embedsOf(entry.payload))
    .filter((embed) => embed.color === COLORS.ERROR);
}

/** The invariants every invocation must hold, whatever its outcome. */
function expectWellBehaved(run: Invocation, error: unknown): void {
  expect(error, 'execute() threw').toBeUndefined();
  expect(
    run.initialResponses,
    'exactly one reply / deferReply / showModal'
  ).toHaveLength(1);
  expect(run.violations, 'responses Discord would reject').toEqual([]);
  expect(logger.error.mock.calls, 'logger.error calls').toEqual([]);
  expect(
    [...run.optionReads].filter((name) => !run.declaredOptions.has(name)),
    'options read that the command does not declare'
  ).toEqual([]);

  const payloads = outgoing(run);
  const texts = payloads.flatMap(textsOf);
  expect(payloads.flatMap(messageLimitProblems)).toEqual([]);
  expect(translationProblems(texts)).toEqual([]);
  expect(
    texts.flatMap((text) => invalidSlashReferences(text, KNOWN_REFERENCES)),
    'replies pointing users at commands that do not exist'
  ).toEqual([]);
}

function isEphemeral(payload: unknown): boolean {
  const flags = (payload as { flags?: unknown } | undefined)?.flags;
  return typeof flags === 'number' && (flags & MessageFlags.Ephemeral) !== 0;
}

/**
 * A refusal: one private error, sent either as a reply or as a private
 * deferral followed by an edit.
 */
function expectRefusal(run: Invocation): void {
  expect([['reply'], ['deferReply', 'editReply']]).toContainEqual(
    run.sent.map((entry) => entry.via)
  );
  expect(isEphemeral(run.sent[0]!.payload), 'the refusal is private').toBe(
    true
  );
  expect(errorEmbeds(run)).toHaveLength(1);
}

/** Row-for-row contents of every table, to prove a run changed nothing. */
function snapshotTables(): Record<string, unknown[]> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ])
  );
}

/** Nothing outside the reply happened: no rows, posts, roles or audio. */
function expectNoSideEffects(before: Record<string, unknown[]>): void {
  expect(snapshotTables()).toEqual(before);
  expect(world.target.roles.add).not.toHaveBeenCalled();
  expect(world.target.roles.remove).not.toHaveBeenCalled();
  expect(world.textChannel.send).not.toHaveBeenCalled();
  expect(voice.manager.disconnect).not.toHaveBeenCalled();
  expect(voice.recordAudio).not.toHaveBeenCalled();
  expect(backup.runBackup).not.toHaveBeenCalled();
}

const executions = (name: string) =>
  metrics.getSnapshot().commands.byName[name] ?? 0;
const failures = (name: string) =>
  metrics.getSnapshot().commands.byName[`${name}:error`] ?? 0;

interface Case {
  path: CommandPath;
  fill: OptionFill;
  locale: 'en-US' | 'ja';
}

/**
 * Each path with required options only, with every option in both
 * languages, and with every option at its upper and lower limits.
 */
const SERVER_CASES: Array<[string, Case]> = paths.flatMap((path) =>
  (
    [
      { path, fill: 'required', locale: 'en-US' },
      { path, fill: 'all', locale: 'en-US' },
      { path, fill: 'all', locale: 'ja' },
      { path, fill: 'max', locale: 'en-US' },
      { path, fill: 'min', locale: 'en-US' },
    ] satisfies Case[]
  ).map((c): [string, Case] => [
    `/${path.label} (${c.fill} options, ${c.locale})`,
    c,
  ])
);

/**
 * Paths Discord can deliver from a DM with the bot, by the declared policy
 * (the payload test holds the registered contexts to the same policy), so a
 * command losing its DM context cannot quietly drop out of this run.
 */
const DM_PATHS = paths.filter(({ entry }) =>
  reachableFromBotDM(
    COMMAND_POLICY[entry.json.name]?.contexts ?? entry.json.contexts
  )
);

describe('command discovery for the smoke run', () => {
  it('loads a command from every feature that ships command files', () => {
    expect([...new Set(commands.map((c) => c.feature))].sort()).toEqual(
      featuresWithCommandFiles()
    );
    expect(paths.length).toBeGreaterThanOrEqual(commands.length);
  });

  it('keeps every scenario attached to a real command path', () => {
    const labels = new Set(paths.map((path) => path.label));
    expect(Object.keys(SCENARIOS).filter((key) => !labels.has(key))).toEqual(
      []
    );
  });

  it('runs the DM cases for exactly the commands registered for DMs', () => {
    const registered = commands
      .filter((entry) => reachableFromBotDM(entry.json.contexts))
      .map((entry) => entry.json.name);

    expect(DM_PATHS.length).toBeGreaterThan(0);
    expect([...new Set(DM_PATHS.map(({ entry }) => entry.json.name))]).toEqual(
      registered
    );
  });
});

describe('every command path in a fully set-up server', () => {
  it.each(SERVER_CASES)('%s', async (_title, { path, fill, locale }) => {
    SCENARIOS[path.label]?.(world);
    const suggestions =
      fill === 'required' ? undefined : await suggestionsFor(path);
    const run = invokeCommand(world, path, {
      fill,
      locale,
      inGuild: true,
      suggestions,
    });

    const error = await settle(path.entry.command.execute(run.interaction));

    expectWellBehaved(run, error);
    expect(
      errorEmbeds(run).map((embed) => `${embed.title}: ${embed.description}`),
      'error responses in a server set up for this command (add a SCENARIOS entry if it needs prior state)'
    ).toEqual([]);
  });
});

describe('every command path reachable from a DM', () => {
  it.each(DM_PATHS.map((path) => [`/${path.label}`, path] as const))(
    '%s degrades gracefully without a guild',
    async (_title, path) => {
      SCENARIOS[path.label]?.(world);
      const run = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: false,
      });

      const error = await settle(path.entry.command.execute(run.interaction));

      expectWellBehaved(run, error);
    }
  );
});

describe('every command path routed like production', () => {
  it.each(paths.map((path) => [`/${path.label}`, path] as const))(
    '%s passes its middleware and is counted as executed',
    async (_title, path) => {
      SCENARIOS[path.label]?.(world);
      const run = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: true,
        suggestions: await suggestionsFor(path),
      });
      const name = path.entry.json.name;
      const before = executions(name);

      const error = await settle(
        routeInteraction(world.client, run.interaction)
      );

      expectWellBehaved(run, error);
      expect(errorEmbeds(run)).toEqual([]);
      expect(executions(name)).toBe(before + 1);
    }
  );
});

const HELP_ENTRIES = new Map(
  buildHelpCatalog(commands.map((entry) => entry.command))
    .flatMap((category) => category.commands)
    .map((info) => [info.name, info])
);

/** Who `/general help` says may use a path (its subcommand / group entry). */
function advertisedLevels(path: CommandPath): PermissionLevel[] {
  const entry = HELP_ENTRIES.get(helpEntryOf(path));
  return [entry?.requiredPermission ?? 'everyone'].flat();
}

/**
 * Members who are not bot owners, from no permissions up to each permission
 * a command here asks for, alone. The fully privileged owner is the "fully
 * set-up server" run above.
 */
const ACTORS: Array<
  [string, { permissions: bigint[]; levels: readonly AccessLevel[] }]
> = [
  ['a member without permissions', { permissions: [], levels: ['everyone'] }],
  [
    'a member with only Manage Server',
    {
      permissions: [PermissionFlagsBits.ManageGuild],
      levels: ['everyone', 'manageGuild'],
    },
  ],
  [
    'a member with only Manage Roles',
    {
      permissions: [PermissionFlagsBits.ManageRoles],
      levels: ['everyone', 'manageRoles'],
    },
  ],
];

describe.each(ACTORS)(
  'every command path for %s',
  (_actor, { permissions, levels }) => {
    beforeEach(() => {
      world = createWorld(OWNER_ID, { permissions, owner: false });
      world.client.commands = buildCommandCollection(commands);
    });

    it.each(paths.map((path) => [`/${path.label}`, path] as const))(
      '%s is served exactly when the policy allows it, and help agrees',
      async (_title, path) => {
        SCENARIOS[path.label]?.(world);
        const before = snapshotTables();
        const run = invokeCommand(world, path, {
          fill: 'all',
          locale: 'en-US',
          inGuild: true,
          suggestions: await suggestionsFor(path),
        });
        // A command without a declared policy fails the policy test; until
        // then, hold it to what help advertises.
        const access = declaredAccess(path);
        const allowed = access
          ? levels.includes(access)
          : advertisedLevels(path).some((level) => levels.includes(level));

        const error = await settle(
          routeInteraction(world.client, run.interaction)
        );

        expectWellBehaved(run, error);
        if (allowed) {
          expect(errorEmbeds(run), 'served without an error').toEqual([]);
        } else {
          expectRefusal(run);
          expectNoSideEffects(before);
        }

        const entry = helpEntryOf(path);
        const info = HELP_ENTRIES.get(entry);
        expect(info, `"${entry}" is listed in /general help`).toBeDefined();
        const overreach = KNOWN_HELP_OVERREACH[entry] ?? [];
        const visible = canUserSeeCommandWithContext(info!, {
          userId: world.actor.id,
          guild: world.guild,
          member: world.actor as { permissions: PermissionsBitField },
        });
        expect(visible, `/general help lists "${entry}" to this member`).toBe(
          allowed || levels.some((level) => overreach.includes(level))
        );
      }
    );
  }
);

/**
 * Drive a routed command until it resolves, moving the clock forward in small
 * steps (so a cooldown is not skipped over the way `runAllTimers` would) and
 * failing once `budgetMs` of command time has passed.
 */
async function runWithin(
  work: Promise<unknown>,
  budgetMs: number
): Promise<unknown> {
  let settled = false;
  const outcome = work
    .then(
      () => undefined,
      (error: unknown) => error ?? new Error('rejected without a reason')
    )
    .finally(() => {
      settled = true;
    });
  // A refused command answers without waiting on any timer.
  for (let i = 0; i < 200 && !settled; i++) await Promise.resolve();
  for (let waited = 0; !settled; waited += 50) {
    if (waited >= budgetMs) {
      throw new Error(`the command was still running after ${budgetMs}ms`);
    }
    await vi.advanceTimersByTimeAsync(50);
  }
  return outcome;
}

const COOLDOWN_CASES = paths.flatMap((path) => {
  const cooldownMs = COMMAND_POLICY[path.entry.json.name]?.cooldownMs;
  return cooldownMs
    ? [[`/${path.label} (${cooldownMs}ms)`, { path, cooldownMs }] as const]
    : [];
});

describe('every command path with a declared cooldown', () => {
  it.each(COOLDOWN_CASES)(
    '%s refuses a repeat by the same user until the cooldown has passed',
    async (_title, { path, cooldownMs }) => {
      SCENARIOS[path.label]?.(world);
      const name = path.entry.json.name;
      const suggestions = await suggestionsFor(path);
      const start = Date.now();
      const invoke = async () => {
        const run = invokeCommand(world, path, {
          fill: 'all',
          locale: 'en-US',
          inGuild: true,
          suggestions,
        });
        const before = executions(name);
        const error = await runWithin(
          routeInteraction(world.client, run.interaction),
          cooldownMs
        );
        return { run, error, executed: executions(name) - before };
      };
      const expectBlocked = ({
        run,
        error,
        executed,
      }: Awaited<ReturnType<typeof invoke>>) => {
        expect(error).toBeUndefined();
        expect(executed, 'execute() ran despite the cooldown').toBe(0);
        expectRefusal(run);
        expect(errorEmbeds(run)[0]!.title).toBe(
          t('common.commandBlocked', 'en')
        );
      };

      const first = await invoke();
      expect(first.executed).toBe(1);
      expect(
        Date.now() - start,
        'the cooldown must outlast the command itself'
      ).toBeLessThan(cooldownMs);

      expectBlocked(await invoke());

      await vi.advanceTimersByTimeAsync(start + cooldownMs - 1 - Date.now());
      expectBlocked(await invoke());

      await vi.advanceTimersByTimeAsync(1);
      expect((await invoke()).executed, 'served once the cooldown ends').toBe(
        1
      );
    }
  );

  it('covers every command whose middleware enforces a cooldown', () => {
    const enforced = commands
      .filter((entry) => effectiveCooldown(entry.command) !== null)
      .map((entry) => entry.json.name);

    expect(COOLDOWN_CASES.length).toBeGreaterThan(0);
    expect([
      ...new Set(COOLDOWN_CASES.map(([, { path }]) => path.entry.json.name)),
    ]).toEqual(enforced);
  });
});

/**
 * Paths that catch a failed response themselves instead of leaving it to the
 * router, with what they had already done by then. Production bug: role.ts
 * wraps the confirmation reply in the same `try` as the role change, so a
 * lost confirmation is reported as "Failed to modify role." although the
 * change went through (and was audited). A retry then says the member
 * already has the role.
 */
const HANDLES_OWN_FAILURE: Record<string, (world: SmokeWorld) => void> = {
  'admin role add': (w) =>
    expect(w.target.roles.add).toHaveBeenCalledWith(w.role.id),
  'admin role remove': (w) =>
    expect(w.target.roles.remove).toHaveBeenCalledWith(w.role.id),
};

/**
 * Paths known to defer or confirm and then edit their reply, so the router's
 * "already acknowledged" branch is certainly exercised below.
 */
const KNOWN_EDITORS = new Set([
  'community poll end',
  'community roulette member',
  'general ping',
  'owner backup run',
  'voice record',
]);

describe('every command path when Discord rejects a response', () => {
  it('keeps its path lists attached to real paths', () => {
    const labels = new Set(paths.map((path) => path.label));
    expect(
      [...Object.keys(HANDLES_OWN_FAILURE), ...KNOWN_EDITORS].filter(
        (label) => !labels.has(label)
      )
    ).toEqual([]);
  });

  it.each(paths.map((path) => [`/${path.label}`, path] as const))(
    '%s gets a private error when its first response fails',
    async (_title, path) => {
      SCENARIOS[path.label]?.(world);
      const name = path.entry.json.name;
      const run = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: true,
        suggestions: await suggestionsFor(path),
        failFirst: 'initialResponse',
      });
      const before = { executed: executions(name), failed: failures(name) };
      // Step the clock rather than run every timer, so a cooldown the
      // failure left behind is still in force for the retry below.
      const budget = COMMAND_POLICY[name]?.cooldownMs ?? 60_000;

      const error = await runWithin(
        routeInteraction(world.client, run.interaction),
        budget
      );

      expect(error, 'routeInteraction() rejected').toBeUndefined();
      // The command's own response was lost; the apology that follows is
      // the one that acknowledges the interaction.
      expect(run.injectedFailures).toHaveLength(1);
      expect(run.violations).toEqual([]);
      expect(run.initialResponses).toEqual(['reply']);
      expect(run.sent).toHaveLength(1);
      expect(isEphemeral(run.sent[0]!.payload)).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);

      const ownHandling = HANDLES_OWN_FAILURE[path.label];
      if (ownHandling) {
        expect(errorEmbeds(run)).toHaveLength(1);
        expect(executions(name)).toBe(before.executed + 1);
        expect(failures(name)).toBe(before.failed);
        ownHandling(world);
        return;
      }

      expect(embedsOf(run.sent[0]!.payload)).toEqual([
        expect.objectContaining({
          title: t('common.error', 'en'),
          description: t('common.unexpectedError', 'en'),
          color: COLORS.ERROR,
        }),
      ]);
      expect(executions(name)).toBe(before.executed);
      expect(failures(name)).toBe(before.failed + 1);
      expect(logger.error).toHaveBeenCalledWith(
        `Error executing command ${name}:`,
        INJECTED_FAILURE
      );

      // A failed run must not leave the user locked out by a cooldown.
      const retry = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: true,
        suggestions: await suggestionsFor(path),
      });
      await runWithin(
        routeInteraction(world.client, retry.interaction),
        budget
      );
      expect(executions(name), 'an immediate retry is served').toBe(
        before.executed + 1
      );
    }
  );

  it.each(paths.map((path) => [`/${path.label}`, path] as const))(
    '%s edits the error into an acknowledged reply when a later edit fails',
    async (_title, path) => {
      SCENARIOS[path.label]?.(world);
      const name = path.entry.json.name;
      const run = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: true,
        suggestions: await suggestionsFor(path),
        failFirst: 'editReply',
      });
      const failedBefore = failures(name);

      const error = await settle(
        routeInteraction(world.client, run.interaction)
      );

      expect(error, 'routeInteraction() rejected').toBeUndefined();
      expect(run.violations).toEqual([]);
      expect(run.initialResponses).toHaveLength(1);
      if (KNOWN_EDITORS.has(path.label)) {
        expect(run.injectedFailures, 'this path edits its reply').toEqual([
          'editReply',
        ]);
      }
      if (run.injectedFailures.length === 0) {
        // This path never edits its reply; it ran normally.
        expect(errorEmbeds(run)).toEqual([]);
        return;
      }

      const last = run.sent.at(-1)!;
      expect(last.via).toBe('editReply');
      expect(embedsOf(last.payload)).toEqual([
        expect.objectContaining({
          description: t('common.unexpectedError', 'en'),
          color: COLORS.ERROR,
        }),
      ]);
      expect(failures(name)).toBe(failedBefore + 1);
    }
  );
});

const AUTOCOMPLETE_CASES = paths.flatMap((path) =>
  path.options
    .filter((option) => option.autocomplete)
    .map(
      (option) => [`/${path.label} ${option.name}:`, { path, option }] as const
    )
);

describe('every autocomplete option', () => {
  it.each(AUTOCOMPLETE_CASES)(
    '%s answers once, through the router, with choices Discord accepts',
    async (_title, { path, option }) => {
      const autocomplete = path.entry.command.autocomplete;
      expect(
        autocomplete,
        'an option marked autocomplete needs a handler'
      ).toBeTypeOf('function');

      for (const focused of ['', 'zz-no-such-command']) {
        const { interaction, respond } = autocompleteFor(
          world,
          path,
          option,
          focused
        );
        await routeInteraction(world.client, interaction);

        expect(respond).toHaveBeenCalledTimes(1);
        const choices = respond.mock.calls[0]![0] as Array<{
          name: string;
          value: string | number;
        }>;
        expect(choices.length).toBeLessThanOrEqual(25);
        for (const choice of choices) {
          expect(choice.name.length).toBeGreaterThan(0);
          expect(choice.name.length).toBeLessThanOrEqual(100);
          if (typeof choice.value === 'string') {
            expect(choice.value.length).toBeLessThanOrEqual(100);
          }
        }
      }
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  it('covers every autocomplete option the policy declares', () => {
    expect(
      AUTOCOMPLETE_CASES.map(
        ([, { path, option }]) => `${path.label} ${option.name}`
      ).sort()
    ).toEqual(
      Object.values(COMMAND_POLICY)
        .flatMap((policy) => policy.autocomplete)
        .sort()
    );
  });

  it('suggests something for an empty query, which the server runs use', async () => {
    expect(AUTOCOMPLETE_CASES.length).toBeGreaterThan(0);
    for (const [, { path }] of AUTOCOMPLETE_CASES) {
      expect((await suggestionsFor(path)).size).toBeGreaterThan(0);
    }
  });
});

describe('interactions the router answers itself', () => {
  it.each(commands.map((entry) => [`/${entry.json.name}`, entry] as const))(
    '%s, still registered at Discord but gone from this build, gets a private "not found"',
    async (_title, entry) => {
      const name = entry.json.name;
      const path = paths.find((candidate) => candidate.entry === entry)!;
      world.client.commands.delete(name);
      const run = invokeCommand(world, path, {
        fill: 'required',
        locale: 'ja',
        inGuild: true,
      });
      const before = executions(name);

      const error = await settle(
        routeInteraction(world.client, run.interaction)
      );

      expect(error).toBeUndefined();
      expect(run.sent.map((sent) => sent.via)).toEqual(['reply']);
      expect(isEphemeral(run.sent[0]!.payload)).toBe(true);
      expect(embedsOf(run.sent[0]!.payload)).toEqual([
        expect.objectContaining({
          title: t('help.commandNotFound', 'ja'),
          description: t('help.commandNotFoundDesc', 'ja', { command: name }),
          color: COLORS.ERROR,
        }),
      ]);
      expect(logger.warn).toHaveBeenCalledWith(`Unknown command: ${name}`);
      expect(executions(name)).toBe(before);
    }
  );

  const WITHOUT_HANDLER = paths
    .filter((path) => !path.entry.command.autocomplete)
    .flatMap((path) =>
      path.options
        .slice(0, 1)
        .map(
          (option) =>
            [`/${path.label} ${option.name}:`, { path, option }] as const
        )
    );

  it.each(WITHOUT_HANDLER)(
    '%s autocomplete, with no handler, gets an empty list',
    async (_title, { path, option }) => {
      const { interaction, respond } = autocompleteFor(
        world,
        path,
        option,
        'x'
      );

      await routeInteraction(world.client, interaction);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith([]);
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  it.each(AUTOCOMPLETE_CASES)(
    '%s autocomplete falls back to an empty list when Discord rejects the suggestions',
    async (_title, { path, option }) => {
      const { interaction, respond } = autocompleteFor(world, path, option, '');
      respond.mockRejectedValueOnce(new Error(INJECTED_FAILURE));

      await expect(
        routeInteraction(world.client, interaction)
      ).resolves.toBeUndefined();

      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenLastCalledWith([]);
      expect(logger.error).toHaveBeenCalledWith(
        `Autocomplete error for ${path.entry.json.name}:`,
        INJECTED_FAILURE
      );
    }
  );

  it('keeps a command without an autocomplete handler in the run above', () => {
    expect(WITHOUT_HANDLER.length).toBeGreaterThan(0);
  });
});

describe('translations the replies are built from', () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const valueAt = (dictionary: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          typeof node === 'object' && node !== null
            ? (node as Record<string, unknown>)[part]
            : undefined,
        dictionary
      );

  it('gives every English string a non-empty Japanese counterpart', () => {
    const missing = leafKeys(en).filter((key) => {
      const value = valueAt(ja, key);
      return typeof value !== 'string' || value.trim() === '';
    });
    const emptyEnglish = leafKeys(en).filter(
      (key) => String(valueAt(en, key)).trim() === ''
    );

    expect(missing).toEqual([]);
    expect(emptyEnglish).toEqual([]);
  });

  it('uses the same {placeholders} in both languages', () => {
    const mismatched = leafKeys(en).flatMap((key) => {
      const english = placeholders(String(valueAt(en, key)));
      const japanese = placeholders(String(valueAt(ja, key)));
      return english.join() === japanese.join()
        ? []
        : [`${key}: en {${english.join(', ')}} vs ja {${japanese.join(', ')}}`];
    });

    expect(mismatched).toEqual([]);
  });
});

/**
 * A smoke run that silently stops at a guard (no guild, no permission, bot
 * not in voice) or runs the wrong handler still "acknowledges once". These
 * anchors prove each path that changes something did its own work - the
 * right row, the right member, the right channel - and nothing a sibling
 * path does.
 */
const REACHES: Array<{
  label: string;
  fill?: OptionFill;
  reached: (world: SmokeWorld) => void;
}> = [
  {
    label: 'voice record',
    reached: (w) =>
      expect(voice.recordAudio).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: w.voiceChannel.id, duration: 30 })
      ),
  },
  {
    label: 'voice autojoin enable',
    reached: (w) => {
      expect(voiceSettingsRepository.isAutoJoinEnabled(w.guild.id)).toBe(true);
      expect(voice.manager.disconnect).not.toHaveBeenCalled();
    },
  },
  {
    label: 'voice autojoin disable',
    reached: (w) => {
      expect(voiceSettingsRepository.isAutoJoinEnabled(w.guild.id)).toBe(false);
      expect(voice.manager.disconnect).toHaveBeenCalledWith(w.voiceChannel.id);
    },
  },
  {
    label: 'voice autojoin exclude',
    reached: (w) => {
      expect(voiceSettingsRepository.listExclusions(w.guild.id)).toEqual([
        w.voiceChannel.id,
      ]);
      expect(voice.manager.disconnect).toHaveBeenCalledWith(w.voiceChannel.id);
      expect(voiceSettingsRepository.isAutoJoinEnabled(w.guild.id)).toBe(true);
    },
  },
  {
    label: 'voice autojoin include',
    reached: (w) => {
      expect(voiceSettingsRepository.listExclusions(w.guild.id)).toEqual([]);
      expect(voice.manager.disconnect).not.toHaveBeenCalled();
    },
  },
  {
    label: 'owner backup run',
    reached: () => expect(backup.runBackup).toHaveBeenCalledTimes(1),
  },
  {
    label: 'owner system broadcast',
    reached: (w) => expect(w.textChannel.send).toHaveBeenCalledTimes(1),
  },
  {
    label: 'community poll create',
    reached: (w) =>
      expect(
        pollRepository.findActiveByCreator(w.actor.id, w.textChannel.id)
      ).not.toBeNull(),
  },
  {
    label: 'community poll end',
    reached: (w) => {
      const poll = w.messages.get(POLL_MESSAGE_ID)?.poll as { end: Mock };
      expect(poll.end).toHaveBeenCalledTimes(1);
      expect(
        pollRepository.findActiveByCreator(w.actor.id, w.textChannel.id)
      ).toBeNull();
    },
  },
  {
    label: 'admin role add',
    reached: (w) => {
      expect(w.target.roles.add).toHaveBeenCalledWith(w.role.id);
      expect(w.target.roles.remove).not.toHaveBeenCalled();
    },
  },
  {
    label: 'admin role remove',
    reached: (w) => {
      expect(w.target.roles.remove).toHaveBeenCalledWith(w.role.id);
      expect(w.target.roles.add).not.toHaveBeenCalled();
      expect(w.target.roles.cache.has(w.role.id)).toBe(false);
    },
  },
  {
    label: 'admin settings language',
    reached: (w) =>
      expect(guildSettingsRepository.getLanguage(w.guild.id)).toBe('en'),
  },
  {
    label: 'admin settings audit',
    fill: 'all',
    reached: (w) => {
      expect(guildSettingsRepository.getAuditChannel(w.guild.id)).toBe(
        w.textChannel.id
      );
      expect(guildSettingsRepository.getAnnouncementChannel(w.guild.id)).toBe(
        null
      );
    },
  },
  {
    label: 'admin settings announcements',
    fill: 'all',
    reached: (w) => {
      expect(guildSettingsRepository.getAnnouncementChannel(w.guild.id)).toBe(
        w.textChannel.id
      );
      expect(guildSettingsRepository.getAuditChannel(w.guild.id)).toBe(null);
    },
  },
  {
    label: 'notification voice set',
    reached: (w) => {
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'voice')
      ).toBe(w.textChannel.id);
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'member_join')
      ).toBeNull();
    },
  },
  {
    label: 'notification voice disable',
    reached: (w) =>
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'voice')
      ).toBeNull(),
  },
  {
    label: 'notification welcome set',
    reached: (w) => {
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'member_join')
      ).toBe(w.textChannel.id);
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'voice')
      ).toBeNull();
    },
  },
  {
    label: 'notification welcome disable',
    reached: (w) =>
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'member_join')
      ).toBeNull(),
  },
];

/**
 * Paths that only show something. Each one is run below and must leave the
 * database, the channel, roles, voice and backups exactly as it found them.
 */
const READ_ONLY = new Set([
  'admin settings view',
  'admin settings logs',
  'community roulette member',
  'community roulette team',
  'general help',
  'general ping',
  'general about',
  'notification status',
  'notification stats',
  'owner system stats',
  'owner system db',
  'owner system guilds',
  'owner system health',
  'owner system metrics',
  'owner backup list',
  'voice status',
]);

describe('the smoke world reaches the real work', () => {
  it('accounts for every path as either doing work or read-only', () => {
    const reaching = new Set(REACHES.map((r) => r.label));
    const labels = paths.map((path) => path.label);

    expect(
      labels.filter((label) => !reaching.has(label) && !READ_ONLY.has(label)),
      'add a REACHES anchor (or a READ_ONLY entry) for these paths'
    ).toEqual([]);
    expect(
      labels.filter((label) => reaching.has(label) && READ_ONLY.has(label))
    ).toEqual([]);
    expect(
      [...reaching, ...READ_ONLY].filter((label) => !labels.includes(label)),
      'stale entries'
    ).toEqual([]);
  });

  it.each(REACHES.map((r) => [`/${r.label}`, r] as const))(
    '%s',
    async (_title, { label, fill = 'required', reached }) => {
      const path = paths.find((candidate) => candidate.label === label);
      expect(path, `no command path "/${label}"`).toBeDefined();
      SCENARIOS[label]?.(world);
      const run = invokeCommand(world, path!, {
        fill,
        locale: 'en-US',
        inGuild: true,
      });

      const error = await settle(path!.entry.command.execute(run.interaction));

      expect(error).toBeUndefined();
      expect(errorEmbeds(run)).toEqual([]);
      reached(world);
    }
  );

  it.each(
    paths
      .filter((path) => READ_ONLY.has(path.label))
      .map((path) => [`/${path.label}`, path] as const)
  )('%s changes nothing', async (_title, path) => {
    SCENARIOS[path.label]?.(world);
    const before = snapshotTables();
    const run = invokeCommand(world, path, {
      fill: 'all',
      locale: 'en-US',
      inGuild: true,
      suggestions: await suggestionsFor(path),
    });

    const error = await settle(path.entry.command.execute(run.interaction));

    expectWellBehaved(run, error);
    expectNoSideEffects(before);
  });
});

describe('the smoke harness itself', () => {
  const TEXT: LooseOption = {
    type: ApplicationCommandOptionType.String,
    name: 'text',
    description: 'Text',
    required: true,
  };

  function fakePath(
    execute: (interaction: ChatInputCommandInteraction) => Promise<void>,
    options: LooseOption[] = [TEXT]
  ): CommandPath {
    const entry = {
      feature: 'fake',
      filePath: 'fake.ts',
      command: { data: {} as never, execute },
      json: { name: 'fake', description: 'Fake', options },
    } as LoadedCommand;
    return { label: 'fake', entry, group: null, subcommand: null, options };
  }

  async function runFake(
    path: CommandPath,
    extra: { fill?: OptionFill; failFirst?: 'initialResponse' } = {}
  ) {
    const run = invokeCommand(world, path, {
      fill: extra.fill ?? 'required',
      locale: 'en-US',
      inGuild: true,
      failFirst: extra.failFirst,
    });
    const error = await settle(path.entry.command.execute(run.interaction));
    return { run, error };
  }

  it('reports a second initial response the way Discord rejects it', async () => {
    const { run, error } = await runFake(
      fakePath(async (interaction) => {
        await interaction.reply('first');
        await interaction.deferReply();
      })
    );

    expect(error).toBeInstanceOf(Error);
    expect(run.initialResponses).toEqual(['reply', 'deferReply']);
    expect(run.violations).toEqual([
      'deferReply after the interaction was already acknowledged',
    ]);
  });

  it.each(['editReply', 'followUp'] as const)(
    'rejects %s before the interaction is acknowledged',
    async (method) => {
      const { run, error } = await runFake(
        fakePath(async (interaction) => {
          await interaction[method]('too early');
        })
      );

      expect(error).toBeInstanceOf(Error);
      expect(run.initialResponses).toEqual([]);
      expect(run.violations).toEqual([
        `${method} before the interaction was acknowledged`,
      ]);
    }
  );

  it('fails only the first response when asked to, without acknowledging', async () => {
    const outcomes: string[] = [];
    const { run } = await runFake(
      fakePath(async (interaction) => {
        await interaction.reply('lost').catch((e: Error) => {
          outcomes.push(e.message);
        });
        await interaction.reply('delivered');
      }),
      { failFirst: 'initialResponse' }
    );

    expect(outcomes).toEqual([INJECTED_FAILURE]);
    expect(run.injectedFailures).toEqual(['reply']);
    expect(run.violations).toEqual([]);
    expect(run.sent).toEqual([{ via: 'reply', payload: 'delivered' }]);
  });

  it('records option names a command reads without declaring them', async () => {
    const { run } = await runFake(
      fakePath(async (interaction) => {
        interaction.options.getString('txet');
        await interaction.reply('ok');
      })
    );

    expect([...run.optionReads]).toEqual(['txet']);
    expect([...run.declaredOptions]).toEqual(['text']);
  });

  it('throws like discord.js when an option is read with the wrong getter', async () => {
    const { error } = await runFake(
      fakePath(async (interaction) => {
        interaction.options.getInteger('text');
        await interaction.reply('unreachable');
      })
    );

    expect(String(error)).toMatch(/text/);
  });

  it('fills a required option from its first choice and skips optional ones', async () => {
    const seen: unknown[] = [];
    await runFake(
      fakePath(
        async (interaction) => {
          seen.push(
            interaction.options.getString('pick', true),
            interaction.options.getInteger('count')
          );
          await interaction.reply('ok');
        },
        [
          {
            ...TEXT,
            name: 'pick',
            choices: [
              { name: 'B', value: 'b' },
              { name: 'A', value: 'a' },
            ],
          },
          {
            type: ApplicationCommandOptionType.Integer,
            name: 'count',
            description: 'Count',
          },
        ]
      )
    );

    expect(seen).toEqual(['b', null]);
  });

  describe('boundary fills', () => {
    const option = (extra: Partial<LooseOption>): LooseOption => ({
      ...TEXT,
      ...extra,
    });
    const valueOf = (o: LooseOption, fill: OptionFill) =>
      sampleOption(world, o, true, undefined, fill).value;

    it('fills strings to their declared length limits, or Discord’s', () => {
      expect(valueOf(option({ max_length: 300 }), 'max')).toHaveLength(300);
      expect(valueOf(option({}), 'max')).toHaveLength(
        DISCORD_OPTION_BOUNDS.maxStringLength
      );
      expect(valueOf(option({ min_length: 4 }), 'min')).toHaveLength(4);
      expect(valueOf(option({}), 'min')).toHaveLength(1);
    });

    it('keeps sibling strings at the same length distinct', () => {
      expect(textOfLength('option1', 55)).not.toBe(textOfLength('option2', 55));
      expect(textOfLength('option1', 55)).toHaveLength(55);
      expect(textOfLength('a-very-long-label', 3)).toHaveLength(3);
    });

    it('fills numbers to their bounds and picks the last choice for max', () => {
      const integer = (extra: Partial<LooseOption>) =>
        option({ type: ApplicationCommandOptionType.Integer, ...extra });

      expect(valueOf(integer({ min_value: 2, max_value: 9 }), 'max')).toBe(9);
      expect(valueOf(integer({ min_value: 2, max_value: 9 }), 'min')).toBe(2);
      expect(valueOf(integer({}), 'max')).toBe(
        DISCORD_OPTION_BOUNDS.maxInteger
      );
      expect(valueOf(integer({}), 'min')).toBe(
        DISCORD_OPTION_BOUNDS.minInteger
      );
      expect(
        valueOf(
          integer({
            choices: [
              { name: 'two', value: 2 },
              { name: 'six', value: 6 },
            ],
          }),
          'max'
        )
      ).toBe(6);
    });
  });

  it('presses the confirm button of a real confirmation prompt', async () => {
    let confirmed: boolean | undefined;
    const { run } = await runFake(
      fakePath(async (interaction) => {
        confirmed = await awaitConfirmation(interaction, 'Proceed?');
      })
    );

    expect(confirmed).toBe(true);
    expect(run.sent.map((entry) => entry.via)).toEqual([
      'reply',
      'component.update',
    ]);
  });

  it('builds the world each actor needs', () => {
    const plain = createWorld(OWNER_ID, {
      permissions: [PermissionFlagsBits.ManageRoles],
      owner: false,
    });

    expect(plain.actor.id).not.toBe(OWNER_ID);
    expect(plain.actor.permissions.has(PermissionFlagsBits.ManageRoles)).toBe(
      true
    );
    expect(plain.actor.permissions.has(PermissionFlagsBits.ManageGuild)).toBe(
      false
    );
    expect(world.actor.id).toBe(OWNER_ID);
    // Enough people for the largest team split a command offers.
    expect(
      world.voiceChannel.members.filter((member) => !member.user.bot).size
    ).toBe(6);
  });

  it('flags payloads Discord would reject', () => {
    const row = () =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('same')
          .setLabel('Go')
          .setStyle(ButtonStyle.Primary)
      );

    expect(
      messageLimitProblems({
        content: 'x'.repeat(2001),
        embeds: [
          new EmbedBuilder().setTitle('T').addFields({ name: 'n', value: '' }),
        ],
        components: [row(), row(), row(), row(), row(), row()],
        poll: { question: { text: 'Q' }, answers: [{ text: 'a'.repeat(56) }] },
      })
    ).toEqual([
      'content is 2001 chars (max 2000)',
      'embed field "n" has an empty name or value',
      '6 action rows (max 5)',
      ...Array.from({ length: 5 }, () => 'custom_id "same" is used twice'),
      `poll answer "${'a'.repeat(56)}" is 56 chars (1-55)`,
    ]);
    expect(
      messageLimitProblems({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setLabel('No id').setStyle(ButtonStyle.Primary)
          ),
        ],
      })
    ).toEqual(['button "No id" has no custom_id']);
  });

  it('flags raw translation keys and unfilled placeholders', () => {
    expect(
      translationProblems([
        'common.error',
        'Hello {name}',
        'All good',
        // What t() returns for a key that no longer exists in en.ts.
        'record.errors.removedKey',
        'Failed:\nnotification.voice.gone',
        'See example.com or v1.2 for details',
      ])
    ).toEqual([
      'raw translation key "common.error" in: common.error',
      'unfilled placeholder in: Hello {name}',
      'raw translation key "record.errors.removedKey" in: record.errors.removedKey',
      'raw translation key "notification.voice.gone" in: Failed:\nnotification.voice.gone',
    ]);
  });

  it('flags references to commands that do not exist', () => {
    expect(
      invalidSlashReferences(
        'Retry `/record` or /nope; `/voice record duration:30s` and /voice status are fine, as is `/{command}`.',
        KNOWN_REFERENCES
      )
    ).toEqual(['/record', '/nope']);
  });
});
