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
 * is smoke-tested with no change to this file.
 *
 * Only true externals are replaced: the database is in-memory SQLite brought
 * up by the real migration runner, voice connections and the recorder are
 * fakes, and backups never touch the disk. Everything between the
 * interaction and those seams - option parsing (discord.js's own resolver),
 * permission checks, repositories, panels, confirmations, audit logging -
 * is the production code.
 *
 * For each path the invariants are the ones Discord and users care about:
 * the command resolves, acknowledges the interaction exactly once, never
 * edits before acknowledging, logs no error, reads only options it
 * declares, sends nothing Discord would reject, and shows no raw translation
 * key or unfilled `{placeholder}`. In a fully set-up server it must also
 * reach a non-error response. A path that only succeeds with some prior
 * state (something to remove, a poll to end) gets it from `SCENARIOS`.
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
  InteractionContextType,
  MessageFlags,
  type APIEmbed,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Mock } from 'vitest';
import { awaitConfirmation } from '../../../shared/utils/confirm.js';
import {
  buildHelpCatalog,
  type PermissionLevel,
} from '../../../shared/help/catalog.js';
import { initializeDatabase } from '../../../infrastructure/database/migrations/index.js';
import { buildCommandCollection } from '../../../app/interactions/commandRegistry.js';
import { routeInteraction } from '../../../app/interactions/interactionRouter.js';
import { clearCooldown } from '../../../middleware/index.js';
import { metrics } from '../../../infrastructure/metrics/index.js';
import { env } from '../../../config/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import { en } from '../../../locales/en.js';
import { ja } from '../../../locales/ja.js';
import { notificationChannelRepository } from '../../../features/notification/repositories/notificationChannelRepository.js';
import { voiceSessionRepository } from '../../../features/notification/repositories/voiceSessionRepository.js';
import { pollRepository } from '../../../features/community/poll/index.js';
import { voiceSettingsRepository } from '../../../features/voice/repositories/voiceSettingsRepository.js';
import {
  autocompleteFor,
  commandPaths,
  createWorld,
  embedsOf,
  featuresWithCommandFiles,
  invalidSlashReferences,
  invokeCommand,
  leafKeys,
  loadCommands,
  messageLimitProblems,
  pathPrefixes,
  textsOf,
  translationProblems,
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

interface Case {
  path: CommandPath;
  fill: OptionFill;
  locale: 'en-US' | 'ja';
}

/** Each path with required options only, then with every option, in both languages. */
const SERVER_CASES: Array<[string, Case]> = paths.flatMap((path) =>
  (
    [
      { path, fill: 'required', locale: 'en-US' },
      { path, fill: 'all', locale: 'en-US' },
      { path, fill: 'all', locale: 'ja' },
    ] satisfies Case[]
  ).map((c): [string, Case] => [
    `/${path.label} (${c.fill} options, ${c.locale})`,
    c,
  ])
);

/** Paths Discord can deliver from a DM with the bot (BotDM context). */
const DM_PATHS = paths.filter(
  ({ entry }) =>
    !entry.json.contexts ||
    entry.json.contexts.includes(InteractionContextType.BotDM)
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
});

describe('every command path in a fully set-up server', () => {
  it.each(SERVER_CASES)('%s', async (_title, { path, fill, locale }) => {
    SCENARIOS[path.label]?.(world);
    const suggestions = fill === 'all' ? await suggestionsFor(path) : undefined;
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
  afterEach(() => {
    for (const command of commands) {
      clearCooldown(command.json.name, OWNER_ID);
    }
  });

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
      const before = metrics.getSnapshot().commands.byName[name] ?? 0;

      const error = await settle(
        routeInteraction(world.client, run.interaction)
      );

      expectWellBehaved(run, error);
      expect(errorEmbeds(run)).toEqual([]);
      expect(metrics.getSnapshot().commands.byName[name] ?? 0).toBe(before + 1);
    }
  );
});

/** Row-for-row contents of every table, to prove a refusal changed nothing. */
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

function isEphemeral(payload: unknown): boolean {
  const flags = (payload as { flags?: unknown } | undefined)?.flags;
  return typeof flags === 'number' && (flags & MessageFlags.Ephemeral) !== 0;
}

const HELP_ENTRIES = new Map(
  buildHelpCatalog(commands.map((entry) => entry.command))
    .flatMap((category) => category.commands)
    .map((info) => [info.name, info])
);

/** Who `/general help` says may use a path (its subcommand / group entry). */
function advertisedLevels(path: CommandPath): PermissionLevel[] {
  const entry =
    HELP_ENTRIES.get(path.label.split(' ').slice(0, 2).join(' ')) ??
    HELP_ENTRIES.get(path.entry.json.name);
  return [entry?.requiredPermission ?? 'everyone'].flat();
}

describe('every command path for a member without permissions', () => {
  beforeEach(() => {
    world = createWorld(OWNER_ID, { privileged: false });
    world.client.commands = buildCommandCollection(commands);
  });

  afterEach(() => {
    for (const command of commands) {
      clearCooldown(command.json.name, world.actor.id);
    }
  });

  it.each(paths.map((path) => [`/${path.label}`, path] as const))(
    '%s is refused, or served, exactly as /general help advertises',
    async (_title, path) => {
      SCENARIOS[path.label]?.(world);
      const before = snapshotTables();
      const run = invokeCommand(world, path, {
        fill: 'all',
        locale: 'en-US',
        inGuild: true,
        suggestions: await suggestionsFor(path),
      });

      const error = await settle(
        routeInteraction(world.client, run.interaction)
      );

      expectWellBehaved(run, error);
      if (advertisedLevels(path).includes('everyone')) {
        expect(errorEmbeds(run)).toEqual([]);
        return;
      }

      // Restricted: one private error, and nothing touched.
      expect(run.sent.map((entry) => entry.via)).toEqual(['reply']);
      expect(isEphemeral(run.sent[0]!.payload)).toBe(true);
      expect(errorEmbeds(run)).toHaveLength(1);
      expect(snapshotTables()).toEqual(before);
      expect(world.target.roles.add).not.toHaveBeenCalled();
      expect(world.target.roles.remove).not.toHaveBeenCalled();
      expect(world.textChannel.send).not.toHaveBeenCalled();
      expect(voice.manager.disconnect).not.toHaveBeenCalled();
      expect(voice.recordAudio).not.toHaveBeenCalled();
      expect(backup.runBackup).not.toHaveBeenCalled();
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

  it('suggests something for an empty query, which the server runs use', async () => {
    for (const [, { path }] of AUTOCOMPLETE_CASES) {
      expect((await suggestionsFor(path)).size).toBeGreaterThan(0);
    }
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
 * not in voice) still "acknowledges once". These anchors prove the world is
 * rich enough to reach the work each feature exists to do.
 */
const REACHES: Array<{
  label: string;
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
    label: 'voice autojoin disable',
    reached: (w) =>
      expect(voice.manager.disconnect).toHaveBeenCalledWith(w.voiceChannel.id),
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
    reached: (w) => expect(w.target.roles.add).toHaveBeenCalledWith(w.role.id),
  },
  {
    label: 'admin settings language',
    reached: (w) =>
      expect(guildSettingsRepository.getLanguage(w.guild.id)).toBe('en'),
  },
  {
    label: 'notification voice set',
    reached: (w) =>
      expect(
        notificationChannelRepository.getEnabled(w.guild.id, 'voice')
      ).toBe(w.textChannel.id),
  },
];

describe('the smoke world reaches the real work', () => {
  it.each(REACHES.map((r) => [`/${r.label}`, r] as const))(
    '%s',
    async (_title, { label, reached }) => {
      const path = paths.find((candidate) => candidate.label === label);
      expect(path, `no command path "/${label}"`).toBeDefined();
      SCENARIOS[label]?.(world);
      const run = invokeCommand(world, path!, {
        fill: 'required',
        locale: 'en-US',
        inGuild: true,
      });

      await settle(path!.entry.command.execute(run.interaction));

      reached(world);
    }
  );
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

  async function runFake(path: CommandPath) {
    const run = invokeCommand(world, path, {
      fill: 'required',
      locale: 'en-US',
      inGuild: true,
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
      translationProblems(['common.error', 'Hello {name}', 'All good'])
    ).toEqual([
      'raw translation key "common.error" in: common.error',
      'unfilled placeholder in: Hello {name}',
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
