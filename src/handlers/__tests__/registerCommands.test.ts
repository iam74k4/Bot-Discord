import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, Routes, SlashCommandBuilder } from 'discord.js';
import type { ExtendedClient } from '../../client.js';
import type { Command } from '../../shared/types/index.js';
import {
  clearCommandIds,
  commandMention,
} from '../../shared/utils/commandMentions.js';

/**
 * Registration skips the PUT while the command set is unchanged, and always
 * leaves the command ids behind for clickable mentions. The REST client is a
 * fake; the sync state lives in a temporary directory.
 */

const env = vi.hoisted(() => ({
  DISCORD_CLIENT_ID: 'app-1',
  DISCORD_GUILD_ID: null as string | null,
  DATA_DIR: 'data/',
}));
vi.mock('../../config/index.js', () => ({ env }));

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

const { registerCommands, commandSyncStatePath, COMMAND_SYNC_STATE_FILE } =
  await import('../commandHandler.js');

const root = mkdtempSync(join(tmpdir(), 'register-commands-'));
let statePath: string;
let caseNo = 0;

function commandNamed(name: string, description = 'test'): Command {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description),
    execute: vi.fn(),
  };
}

function clientWith(commands: Command[]) {
  const collection = new Collection<string, Command>();
  for (const command of commands) collection.set(command.data.name, command);
  const registered = commands.map((command, index) => ({
    id: `${100 + index}`,
    name: command.data.name,
  }));
  const rest = {
    put: vi.fn().mockResolvedValue(registered),
    get: vi.fn().mockResolvedValue(registered),
  };
  const client = { commands: collection, rest } as unknown as ExtendedClient;
  return { client, rest };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.DISCORD_GUILD_ID = null;
  statePath = join(root, `case-${caseNo++}`, COMMAND_SYNC_STATE_FILE);
  delete process.env.FORCE_COMMAND_SYNC;
});

afterEach(() => {
  clearCommandIds();
  delete process.env.FORCE_COMMAND_SYNC;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('registerCommands', () => {
  it('registers on first boot, keeps the ids and records the sync', async () => {
    const { client, rest } = clientWith([commandNamed('voice')]);

    await registerCommands(client, { statePath });

    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(rest.put).toHaveBeenCalledWith(Routes.applicationCommands('app-1'), {
      body: [expect.objectContaining({ name: 'voice' })],
    });
    expect(commandMention('voice record')).toBe('</voice record:100>');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips the PUT for an unchanged command set, but still learns the ids', async () => {
    const first = clientWith([commandNamed('voice'), commandNamed('admin')]);
    await registerCommands(first.client, { statePath });
    clearCommandIds();

    const second = clientWith([commandNamed('voice'), commandNamed('admin')]);
    second.rest.get.mockResolvedValue([
      { id: '900', name: 'voice' },
      { id: '901', name: 'admin' },
    ]);
    await registerCommands(second.client, { statePath });

    expect(second.rest.put).not.toHaveBeenCalled();
    expect(second.rest.get).toHaveBeenCalledWith(
      Routes.applicationCommands('app-1')
    );
    expect(commandMention('admin settings view')).toBe(
      '</admin settings view:901>'
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Slash commands unchanged (global); skipped registration'
    );
  });

  it('registers again once a command changes', async () => {
    await registerCommands(clientWith([commandNamed('voice', 'old')]).client, {
      statePath,
    });

    const changed = clientWith([commandNamed('voice', 'new description')]);
    await registerCommands(changed.client, { statePath });

    expect(changed.rest.put).toHaveBeenCalledTimes(1);
    expect(changed.rest.get).not.toHaveBeenCalled();
  });

  it('registers when switching between global and guild registration', async () => {
    await registerCommands(clientWith([commandNamed('voice')]).client, {
      statePath,
    });

    env.DISCORD_GUILD_ID = 'guild-9';
    const guild = clientWith([commandNamed('voice')]);
    await registerCommands(guild.client, { statePath });

    expect(guild.rest.put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands('app-1', 'guild-9'),
      expect.anything()
    );
  });

  it.each([
    ['the force option', { force: true }, undefined],
    ['FORCE_COMMAND_SYNC=true', {}, 'true'],
  ])(
    'registers an unchanged set when asked to by %s',
    async (_label, extra, flag) => {
      await registerCommands(clientWith([commandNamed('voice')]).client, {
        statePath,
      });
      if (flag) process.env.FORCE_COMMAND_SYNC = flag;

      const again = clientWith([commandNamed('voice')]);
      await registerCommands(again.client, { statePath, ...extra });

      expect(again.rest.put).toHaveBeenCalledTimes(1);
    }
  );

  it('registers when commands were removed outside the bot since the last sync', async () => {
    await registerCommands(clientWith([commandNamed('voice')]).client, {
      statePath,
    });

    const again = clientWith([commandNamed('voice')]);
    again.rest.get.mockResolvedValue([]);
    await registerCommands(again.client, { statePath });

    expect(again.rest.put).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Registered global commands no longer match the last sync; registering again'
    );
  });

  it('registers when the registered commands cannot be fetched', async () => {
    await registerCommands(clientWith([commandNamed('voice')]).client, {
      statePath,
    });

    const again = clientWith([commandNamed('voice')]);
    again.rest.get.mockRejectedValue(new Error('503'));
    await registerCommands(again.client, { statePath });

    expect(again.rest.put).toHaveBeenCalledTimes(1);
  });

  it('leaves the sync state alone when the PUT fails, so the next boot retries', async () => {
    const failing = clientWith([commandNamed('voice')]);
    failing.rest.put.mockRejectedValue(new Error('429'));

    await expect(
      registerCommands(failing.client, { statePath })
    ).rejects.toThrow('429');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to register commands:',
      '429'
    );

    const retry = clientWith([commandNamed('voice')]);
    await registerCommands(retry.client, { statePath });
    expect(retry.rest.put).toHaveBeenCalledTimes(1);
  });

  it('still registers when the sync state cannot be written', async () => {
    const blocker = join(root, `blocker-${caseNo++}`);
    writeFileSync(blocker, 'a file where a directory should be');
    const { client, rest } = clientWith([commandNamed('voice')]);

    await registerCommands(client, {
      statePath: join(blocker, COMMAND_SYNC_STATE_FILE),
    });

    expect(rest.put).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not record the command sync state')
    );
  });

  it('treats a corrupt sync state as no sync', async () => {
    writeFileSync(join(root, 'corrupt.json'), '{ not json');
    const { client, rest } = clientWith([commandNamed('voice')]);

    await registerCommands(client, { statePath: join(root, 'corrupt.json') });

    expect(rest.put).toHaveBeenCalledTimes(1);
  });
});

describe('commandSyncStatePath', () => {
  it('keeps the sync state in the data directory', () => {
    expect(commandSyncStatePath('data/')).toBe(
      join('data', 'command-sync.json')
    );
    expect(commandSyncStatePath()).toBe(join('data', 'command-sync.json'));
  });
});
