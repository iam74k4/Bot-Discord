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

import type { APIEmbed } from 'discord.js';
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
      creator_id: world.ownerId,
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
      world.ownerId,
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
  label: string;
  path: CommandPath;
  fill: OptionFill;
  locale: 'en-US' | 'ja';
}

const SERVER_CASES: Case[] = paths.flatMap((path) => [
  { label: path.label, path, fill: 'required' as const, locale: 'en-US' as const },
  { label: path.label, path, fill: 'all' as const, locale: 'en-US' as const },
  { label: path.label, path, fill: 'all' as const, locale: 'ja' as const },
]);

/** Paths Discord can deliver from a DM with the bot (BotDM context). */
const DM_PATHS = paths.filter(
  ({ entry }) => !entry.json.contexts || entry.json.contexts.includes(1)
);

describe('command discovery for the smoke run', () => {
  it('finds commands in every feature that has a commands folder', () => {
    expect(new Set(commands.map((c) => c.feature))).toEqual(
      new Set(['admin', 'community', 'general', 'notification', 'voice'])
    );
    expect(paths.length).toBeGreaterThan(commands.length);
  });

  it('keeps every scenario attached to a real command path', () => {
    const labels = new Set(paths.map((path) => path.label));
    expect(Object.keys(SCENARIOS).filter((key) => !labels.has(key))).toEqual(
      []
    );
  });
});

describe('every command path in a fully set-up server', () => {
  it.each(SERVER_CASES)(
    '/$label ($fill options, $locale)',
    async ({ path, fill, locale }) => {
      SCENARIOS[path.label]?.(world);
      const suggestions =
        fill === 'all' ? await suggestionsFor(path) : undefined;
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
    }
  );
});

describe('every command path reachable from a DM', () => {
  it.each(DM_PATHS.map((path) => ({ label: path.label, path })))(
    '/$label degrades gracefully without a guild',
    async ({ path }) => {
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

  it.each(paths.map((path) => ({ label: path.label, path })))(
    '/$label passes its middleware and is counted as executed',
    async ({ path }) => {
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
      expect(metrics.getSnapshot().commands.byName[name] ?? 0).toBe(
        before + 1
      );
    }
  );
});

const AUTOCOMPLETE_CASES = paths.flatMap((path) =>
  path.options
    .filter((option) => option.autocomplete)
    .map((option) => ({
      label: `${path.label} ${option.name}`,
      path,
      option,
    }))
);

describe('every autocomplete option', () => {
  it('exists somewhere, so this block is not vacuous', () => {
    expect(AUTOCOMPLETE_CASES.length).toBeGreaterThan(0);
  });

  it.each(AUTOCOMPLETE_CASES)(
    '/$label answers once with choices Discord accepts',
    async ({ path, option }) => {
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
        await autocomplete!(interaction);

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
    for (const { path } of AUTOCOMPLETE_CASES) {
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
