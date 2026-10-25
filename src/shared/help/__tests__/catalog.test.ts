import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../types/command.js';
import { discoverFeatureCommands } from '../../../app/interactions/commandRegistry.js';
import { buildHelpCatalog, type CommandCategory } from '../catalog.js';

const FEATURES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'features'
);

function command(overrides: Partial<Command> & { data: Command['data'] }) {
  return { execute: async () => {}, ...overrides } as Command;
}

describe('buildHelpCatalog', () => {
  it('takes names and descriptions from the command definition', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder()
          .setName('demo')
          .setDescription('A demo command')
          .setDescriptionLocalizations({ ja: 'デモコマンド' }),
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.name).toEqual({ en: 'Demo', ja: 'デモ' });
    expect(category.commands[0].name).toBe('demo');
    expect(category.commands[0].description).toEqual({
      en: 'A demo command',
      ja: 'デモコマンド',
    });
  });

  it('falls back to the English description when none is localized', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder()
          .setName('demo')
          .setDescription('Only English'),
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.commands[0].description.ja).toBe('Only English');
  });

  it('lists one entry per subcommand, with its own description', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder()
          .setName('demo')
          .setDescription('d')
          .addSubcommand((sub) =>
            sub
              .setName('one')
              .setDescription('First')
              .setDescriptionLocalizations({ ja: 'ひとつ' })
          )
          .addSubcommandGroup((group) =>
            group
              .setName('group')
              .setDescription('A group')
              .addSubcommand((sub) => sub.setName('two').setDescription('2'))
              .addSubcommand((sub) => sub.setName('three').setDescription('3'))
          ),
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.commands.map((c) => c.name)).toEqual([
      'demo one',
      'demo group',
    ]);
    expect(category.commands[0].description).toEqual({
      en: 'First',
      ja: 'ひとつ',
    });
    // A group's usage lists the leaves people actually type.
    expect(category.commands[1].usage).toBe(
      '/demo group two, /demo group three'
    );
  });

  it('lists the command itself when it has no subcommands', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder().setName('demo').setDescription('d'),
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.commands[0].name).toBe('demo');
    expect(category.commands[0].usage).toBe('/demo');
  });

  it('lets a subcommand override a permission the builder cannot express', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder()
          .setName('demo')
          .setDescription('d')
          .addSubcommand((sub) => sub.setName('open').setDescription('o'))
          .addSubcommand((sub) => sub.setName('closed').setDescription('c')),
        help: {
          category: { en: 'Demo', ja: 'デモ' },
          permission: 'everyone',
          subcommandPermissions: { 'demo closed': 'manageGuild' },
        },
      }),
    ]);

    expect(category.commands[0].requiredPermission).toBe('everyone');
    expect(category.commands[1].requiredPermission).toBe('manageGuild');
  });

  it('derives the permission level from middleware requirements', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder().setName('demo').setDescription('d'),
        options: { permissions: [PermissionFlagsBits.ManageGuild] },
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.commands[0].requiredPermission).toBe('manageGuild');
  });

  it('derives it from the default member permission too', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder()
          .setName('demo')
          .setDescription('d')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
        help: { category: { en: 'Demo', ja: 'デモ' } },
      }),
    ]);

    expect(category.commands[0].requiredPermission).toBe('manageRoles');
  });

  it('lets a command declare what the builder cannot express', () => {
    const [category] = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder().setName('demo').setDescription('d'),
        help: { category: { en: 'Demo', ja: 'デモ' }, permission: 'owner' },
      }),
    ]);

    expect(category.commands[0].requiredPermission).toBe('owner');
  });

  it('groups commands that share a category', () => {
    const categories = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder().setName('a').setDescription('a'),
        help: { category: { en: 'Same', ja: '同じ' } },
      }),
      command({
        data: new SlashCommandBuilder().setName('b').setDescription('b'),
        help: { category: { en: 'Same', ja: '同じ' } },
      }),
    ]);

    expect(categories).toHaveLength(1);
    expect(categories[0].commands.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('omits commands that declare no help metadata', () => {
    const categories = buildHelpCatalog([
      command({
        data: new SlashCommandBuilder().setName('hidden').setDescription('h'),
      }),
    ]);

    expect(categories).toEqual([]);
  });
});

describe('the real command definitions', () => {
  let categories: CommandCategory[];

  beforeAll(async () => {
    const discovered = await discoverFeatureCommands(FEATURES_PATH);
    categories = buildHelpCatalog(discovered.map((item) => item.command));
  });

  it('cover every top-level command', () => {
    const roots = new Set(
      categories.flatMap((c) => c.commands.map((cmd) => cmd.name.split(' ')[0]))
    );

    expect([...roots].sort()).toEqual([
      'admin',
      'community',
      'general',
      'notification',
      'owner',
      'tts',
      'voice',
    ]);
  });

  it('keep /owner visible only to bot owners', () => {
    const ownerEntries = categories
      .flatMap((c) => c.commands)
      .filter((cmd) => cmd.name.startsWith('owner '));

    expect(ownerEntries.length).toBeGreaterThan(0);
    for (const entry of ownerEntries) {
      expect(entry.requiredPermission).toBe('owner');
    }
  });

  it('mark /voice as requiring Manage Server without being told', () => {
    const autojoin = categories
      .flatMap((c) => c.commands)
      .find((cmd) => cmd.name === 'voice autojoin');

    // Derived from the command's own middleware declaration.
    expect(autojoin?.requiredPermission).toBe('manageGuild');
    expect(autojoin?.usage).toContain('/voice autojoin exclude');
  });

  it('keep /notification stats open while its settings stay restricted', () => {
    const entries = categories.flatMap((c) => c.commands);
    const stats = entries.find((cmd) => cmd.name === 'notification stats');
    const voice = entries.find((cmd) => cmd.name === 'notification voice');

    expect(stats?.requiredPermission).toBe('everyone');
    expect(voice?.requiredPermission).toBe('manageGuild');
  });
});
