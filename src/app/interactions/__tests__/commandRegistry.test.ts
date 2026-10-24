import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../../shared/types/index.js';
import {
  buildCommandCollection,
  discoverFeatureCommands,
  toDeploymentPayload,
  type DiscoveredCommand,
} from '../commandRegistry.js';

/**
 * Commands are discovered from `features/<feature>/commands/*.{ts,js}` at
 * startup. Each test lays out a throwaway features tree in the OS temp
 * directory (a fresh one per test, so the module cache never serves a file
 * from an earlier test) and checks what the loader accepts and rejects.
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

const root = mkdtempSync(join(tmpdir(), 'command-registry-'));
let counter = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** A valid command module body exported as `default`. */
const validDefault = (name: string) =>
  `export default { data: { name: '${name}' }, execute: async () => {} };\n`;

/**
 * Write `files` (paths relative to the features root) and return the root.
 * A path ending in `/` creates an empty directory.
 */
function featuresTree(files: Record<string, string>): string {
  const dir = join(root, `features-${++counter}`);
  mkdirSync(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    if (relative.endsWith('/')) {
      mkdirSync(full, { recursive: true });
      continue;
    }
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function names(discovered: DiscoveredCommand[]): string[] {
  return discovered.map((d) => d.command.data.name).sort();
}

describe('discoverFeatureCommands', () => {
  it('returns nothing when the features directory does not exist', async () => {
    await expect(
      discoverFeatureCommands(join(root, 'does-not-exist'))
    ).resolves.toEqual([]);
  });

  it('loads default and named `command` exports, tagged with their feature and path', async () => {
    const dir = featuresTree({
      'general/commands/ping.ts': validDefault('ping'),
      'voice/commands/record.js':
        "export const command = { data: { name: 'record' }, execute() {} };\n",
    });

    const discovered = await discoverFeatureCommands(dir);

    expect(names(discovered)).toEqual(['ping', 'record']);
    const byName = Object.fromEntries(
      discovered.map((d) => [d.command.data.name, d])
    );
    expect(byName.ping).toMatchObject({
      feature: 'general',
      filePath: join(dir, 'general', 'commands', 'ping.ts'),
    });
    expect(byName.record).toMatchObject({
      feature: 'voice',
      filePath: join(dir, 'voice', 'commands', 'record.js'),
    });
    expect(typeof byName.record.command.execute).toBe('function');
  });

  it('prefers the default export over a named `command` export', async () => {
    const dir = featuresTree({
      'general/commands/both.js': [
        "export const command = { data: { name: 'named' }, execute() {} };",
        "export default { data: { name: 'default' }, execute() {} };",
      ].join('\n'),
    });

    expect(names(await discoverFeatureCommands(dir))).toEqual(['default']);
  });

  it('skips index files, non-script files, folders without commands, and stray root files', async () => {
    const dir = featuresTree({
      'general/commands/ping.ts': validDefault('ping'),
      'general/commands/index.ts': validDefault('from-index-ts'),
      'general/commands/index.js': validDefault('from-index-js'),
      'general/commands/README.md': '# not a command',
      'general/commands/data.json': '{}',
      'shared/helpers.ts': validDefault('no-commands-dir'),
      'empty/': '',
      'stray.ts': validDefault('stray'),
    });

    const discovered = await discoverFeatureCommands(dir);

    expect(names(discovered)).toEqual(['ping']);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['no execute', "export default { data: { name: 'x' } };"],
    [
      'execute is not a function',
      "export default { data: { name: 'x' }, execute: 'nope' };",
    ],
    ['no data', 'export default { execute() {} };'],
    ['empty name', "export default { data: { name: '' }, execute() {} };"],
    ['a primitive default export', 'export default 42;'],
    [
      'no recognised export',
      "export const other = { data: { name: 'x' }, execute() {} };",
    ],
  ])(
    'rejects a module with %s and keeps loading the rest',
    async (_label, body) => {
      const dir = featuresTree({
        'general/commands/bad.js': body,
        'general/commands/ping.js': validDefault('ping'),
      });

      const discovered = await discoverFeatureCommands(dir);

      expect(names(discovered)).toEqual(['ping']);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        `Invalid command file: ${join(dir, 'general', 'commands', 'bad.js')} - missing data.name or execute`
      );
    }
  );

  it('logs and skips a module that throws while loading', async () => {
    const dir = featuresTree({
      'general/commands/broken.js': "throw new Error('top-level boom');\n",
      'general/commands/ping.js': validDefault('ping'),
    });

    const discovered = await discoverFeatureCommands(dir);

    expect(names(discovered)).toEqual(['ping']);
    expect(logger.error).toHaveBeenCalledWith(
      `Failed to load command from ${join(dir, 'general', 'commands', 'broken.js')}:`,
      'top-level boom'
    );
  });
});

describe('buildCommandCollection', () => {
  function discovered(name: string, feature = 'general'): DiscoveredCommand {
    return {
      feature,
      filePath: `/features/${feature}/commands/${name}.ts`,
      command: {
        data: new SlashCommandBuilder().setName(name).setDescription(name),
        execute: vi.fn(),
      },
    };
  }

  it('keys each command by its slash command name', () => {
    const ping = discovered('ping');
    const help = discovered('help');

    const collection = buildCommandCollection([ping, help]);

    expect([...collection.keys()]).toEqual(['ping', 'help']);
    expect(collection.get('ping')).toBe(ping.command);
    expect(collection.get('help')).toBe(help.command);
  });

  it('lets a later command with the same name replace an earlier one', () => {
    const first = discovered('ping', 'general');
    const second = discovered('ping', 'admin');

    const collection = buildCommandCollection([first, second]);

    expect(collection.size).toBe(1);
    expect(collection.get('ping')).toBe(second.command);
  });

  it('is empty for no commands', () => {
    expect(buildCommandCollection([]).size).toBe(0);
  });
});

describe('toDeploymentPayload', () => {
  it('serialises every command to its REST JSON', () => {
    const commands: Command[] = [
      {
        data: new SlashCommandBuilder()
          .setName('ping')
          .setDescription('Check latency'),
        execute: vi.fn(),
      },
      {
        data: new SlashCommandBuilder()
          .setName('echo')
          .setDescription('Repeat text')
          .addStringOption((o) =>
            o.setName('text').setDescription('Text').setRequired(true)
          ),
        execute: vi.fn(),
      },
    ];

    const payload = toDeploymentPayload(
      buildCommandCollection(
        commands.map((command) => ({ feature: 'f', filePath: 'p', command }))
      )
    );

    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      name: 'ping',
      description: 'Check latency',
    });
    expect(payload[1]).toMatchObject({
      name: 'echo',
      options: [expect.objectContaining({ name: 'text', required: true })],
    });
  });
});
