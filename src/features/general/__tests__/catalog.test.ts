import {
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildHelpCatalog,
  type CommandHelp,
} from '../../../shared/help/catalog.js';
import type { Command, SlashCommandData } from '../../../shared/types/index.js';
import {
  canUserSeeCommandWithContext,
  formatPermissionAlternatives,
} from '../application/visibility.js';
import { t } from '../../../locales/index.js';
import { helpCommand } from './general.helpers.js';

// The real config, so owner checks have a known owner.
vi.mock('../../../config/env.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/env.js')>();
  actual.loadConfig({ BOT_OWNER_IDS: 'owner-1' });
  return actual;
});

/**
 * What `/general help` lists is derived from the command definitions. The
 * basics are covered next to the catalog (src/shared/help/__tests__); these
 * cases pin the shapes `/general help` relies on that are easy to break:
 * commands without subcommands, nested groups, how permissions combine, and
 * how categories merge.
 */

const DEMO = { en: 'Demo', ja: 'デモ' };

type CommandJSON = RESTPostAPIChatInputApplicationCommandsJSONBody;

/**
 * A command whose definition is given as the JSON `toJSON()` produces, for
 * shapes the builder will not emit (missing arrays, null localizations).
 */
function rawCommand(
  json: Partial<CommandJSON> & { name: string },
  help: CommandHelp = { category: DEMO }
): Command {
  const data = {
    name: json.name,
    toJSON: () => ({ description: json.name, ...json }),
  } as unknown as SlashCommandData;
  return helpCommand(data, help);
}

function entriesOf(...commands: Command[]) {
  return buildHelpCatalog(commands).flatMap((category) => category.commands);
}

describe('catalog entries', () => {
  it('lists a command without an options array as itself', () => {
    expect(
      entriesOf(rawCommand({ name: 'bare', description: 'Bare' }))
    ).toEqual([
      {
        name: 'bare',
        description: { en: 'Bare', ja: 'Bare' },
        usage: '/bare',
        leaves: [
          {
            path: 'bare',
            description: { en: 'Bare', ja: 'Bare' },
            options: [],
          },
        ],
        requiredPermission: 'everyone',
      },
    ]);
  });

  it('lists a command that only takes arguments as itself', () => {
    const search = helpCommand(
      new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search')
        .setDescriptionLocalizations({ ja: '検索' })
        .addStringOption((o) =>
          o
            .setName('query')
            .setNameLocalizations({ ja: '言葉' })
            .setDescription('q')
            .setDescriptionLocalizations({ ja: '検索語' })
            .setRequired(true)
        )
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription('l')
            .addChoices(
              { name: 'Ten', value: 10, name_localizations: { ja: '10件' } },
              { name: 'All', value: 0 }
            )
        ),
      { category: DEMO }
    );

    expect(entriesOf(search)).toEqual([
      {
        name: 'search',
        description: { en: 'Search', ja: '検索' },
        usage: '/search',
        leaves: [
          {
            path: 'search',
            description: { en: 'Search', ja: '検索' },
            options: [
              {
                name: { en: 'query', ja: '言葉' },
                description: { en: 'q', ja: '検索語' },
                required: true,
              },
              {
                name: { en: 'limit', ja: 'limit' },
                description: { en: 'l', ja: 'l' },
                required: false,
                choices: [
                  { en: 'Ten', ja: '10件' },
                  { en: 'All', ja: 'All' },
                ],
              },
            ],
          },
        ],
        requiredPermission: 'everyone',
      },
    ]);
  });

  it('gives a group one leaf per subcommand, each with its own options', () => {
    const cfg = helpCommand(
      new SlashCommandBuilder()
        .setName('cfg')
        .setDescription('c')
        .addSubcommandGroup((group) =>
          group
            .setName('set')
            .setDescription('Set things')
            .addSubcommand((sub) =>
              sub
                .setName('name')
                .setDescription('Rename')
                .setDescriptionLocalizations({ ja: '名前を変える' })
                .addStringOption((o) =>
                  o
                    .setName('value')
                    .setDescription('New name')
                    .setRequired(true)
                )
            )
            .addSubcommand((sub) =>
              sub.setName('reset').setDescription('Reset')
            )
        ),
      { category: DEMO }
    );

    const [entry] = entriesOf(cfg);

    expect(entry.leaves).toEqual([
      {
        path: 'cfg set name',
        description: { en: 'Rename', ja: '名前を変える' },
        options: [
          {
            name: { en: 'value', ja: 'value' },
            description: { en: 'New name', ja: 'New name' },
            required: true,
          },
        ],
      },
      {
        path: 'cfg set reset',
        description: { en: 'Reset', ja: 'Reset' },
        options: [],
      },
    ]);
  });

  it('attaches declared examples to the leaf they demonstrate', () => {
    const example = { en: '`/ex run` go', ja: '`/ex run` 実行' };
    const ex = helpCommand(
      new SlashCommandBuilder()
        .setName('ex')
        .setDescription('e')
        .addSubcommand((sub) => sub.setName('run').setDescription('Run'))
        .addSubcommand((sub) => sub.setName('stop').setDescription('Stop')),
      {
        category: DEMO,
        // A key that names no leaf is ignored rather than shown somewhere.
        examples: { 'ex run': [example], 'ex gone': [example] },
      }
    );

    const entries = entriesOf(ex);

    expect(entries.map((e) => e.leaves?.[0].examples)).toEqual([
      [example],
      undefined,
    ]);
  });

  it('falls back to English when localizations are null', () => {
    const [entry] = entriesOf(
      rawCommand({
        name: 'nulls',
        description: 'English',
        description_localizations: null,
      })
    );

    expect(entry.description).toEqual({ en: 'English', ja: 'English' });
  });

  it('skips plain arguments that sit beside subcommands', () => {
    const mixed = rawCommand({
      name: 'mixed',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'stray',
          description: 'not a subcommand',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'run',
          description: 'Run it',
        },
      ],
    });

    expect(entriesOf(mixed).map((e) => e.name)).toEqual(['mixed run']);
  });

  it('collects the leaves of nested groups into the usage line', () => {
    const nested = rawCommand({
      name: 'deep',
      options: [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'outer',
          description: 'Outer',
          options: [
            {
              type: ApplicationCommandOptionType.SubcommandGroup,
              name: 'inner',
              description: 'Inner',
              options: [
                {
                  type: ApplicationCommandOptionType.Subcommand,
                  name: 'leaf',
                  description: 'Leaf',
                },
              ],
            },
            // Not a leaf: neither a subcommand nor a group.
            {
              type: ApplicationCommandOptionType.String,
              name: 'arg',
              description: 'Arg',
            },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: 'top',
              description: 'Top',
            },
          ],
        },
      ] as CommandJSON['options'],
    });

    expect(entriesOf(nested)).toEqual([
      expect.objectContaining({
        name: 'deep outer',
        usage: '/deep outer inner leaf, /deep outer top',
      }),
    ]);
  });

  it('contributes nothing to the usage line for an empty nested group', () => {
    const sparse = rawCommand({
      name: 'sparse',
      options: [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'outer',
          description: 'Outer',
          options: [
            // A nested group with no options array at all.
            {
              type: ApplicationCommandOptionType.SubcommandGroup,
              name: 'void',
              description: 'Void',
            },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: 'run',
              description: 'Run',
            },
          ],
        },
      ] as CommandJSON['options'],
    });

    expect(entriesOf(sparse)).toEqual([
      expect.objectContaining({
        name: 'sparse outer',
        usage: '/sparse outer run',
      }),
    ]);
  });

  it('gives a group without subcommands an empty usage', () => {
    const empty = rawCommand({
      name: 'hollow',
      options: [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'nothing',
          description: 'Nothing here',
        } as NonNullable<CommandJSON['options']>[number],
      ],
    });

    expect(entriesOf(empty)).toEqual([
      expect.objectContaining({ name: 'hollow nothing', usage: '' }),
    ]);
  });
});

describe('catalog permissions', () => {
  const base = () =>
    new SlashCommandBuilder().setName('perm').setDescription('Perm');

  it('prefers Manage Server when a command requires both permissions', () => {
    const both = helpCommand(
      base(),
      { category: DEMO },
      {
        options: {
          permissions: [
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.ManageGuild,
          ],
        },
      }
    );

    expect(entriesOf(both)[0].requiredPermission).toBe('manageGuild');
  });

  it('derives Manage Roles from either declaration', () => {
    const viaMiddleware = helpCommand(
      base(),
      { category: DEMO },
      { options: { permissions: [PermissionFlagsBits.ManageRoles] } }
    );
    const viaDefault = helpCommand(
      base().setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
      { category: DEMO }
    );

    expect(entriesOf(viaMiddleware)[0].requiredPermission).toBe('manageRoles');
    expect(entriesOf(viaDefault)[0].requiredPermission).toBe('manageRoles');
  });

  it('combines middleware and default member permissions', () => {
    const combined = helpCommand(
      base().setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
      { category: DEMO },
      { options: { permissions: [PermissionFlagsBits.ManageRoles] } }
    );

    expect(entriesOf(combined)[0].requiredPermission).toBe('manageGuild');
  });

  it('treats permissions help does not model as open to everyone', () => {
    const kick = helpCommand(
      base().setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
      { category: DEMO },
      { options: { permissions: [PermissionFlagsBits.BanMembers] } }
    );

    expect(entriesOf(kick)[0].requiredPermission).toBe('everyone');
  });

  // Regression: Discord reads a default permission of "0" as administrators
  // only, but "0" sets no bit, so help used to list the command to every
  // member.
  it('treats default permission 0 as administrators only', () => {
    const adminOnly = helpCommand(base().setDefaultMemberPermissions(0), {
      category: DEMO,
    });
    const [entry] = entriesOf(adminOnly);
    const seenBy = (permissions: bigint) =>
      canUserSeeCommandWithContext(entry, {
        userId: 'member-1',
        guild: { id: 'guild-1' },
        member: { permissions: new PermissionsBitField(permissions) },
      });

    expect(
      (adminOnly.data.toJSON() as CommandJSON).default_member_permissions
    ).toBe('0');
    expect(entry.requiredPermission).toBe('administrator');
    expect(seenBy(0n)).toBe(false);
    expect(seenBy(PermissionFlagsBits.ManageGuild)).toBe(false);
    expect(seenBy(PermissionFlagsBits.Administrator)).toBe(true);
    expect(formatPermissionAlternatives(entry, 'ja')).toBe(
      t('help.permission.administrator', 'ja')
    );
  });

  it('keeps an explicit owner-only declaration over default permission 0', () => {
    const ownerOnly = helpCommand(base().setDefaultMemberPermissions(0), {
      category: DEMO,
      permission: 'owner',
    });

    expect(entriesOf(ownerOnly)[0].requiredPermission).toBe('owner');
  });

  it('lets an explicit permission override the derived one', () => {
    const relaxed = helpCommand(
      base().setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
      { category: DEMO, permission: 'everyone' }
    );
    const multi = helpCommand(
      new SlashCommandBuilder().setName('multi').setDescription('m'),
      { category: DEMO, permission: ['manageRoles', 'owner'] }
    );

    expect(entriesOf(relaxed)[0].requiredPermission).toBe('everyone');
    expect(entriesOf(multi)[0].requiredPermission).toEqual([
      'manageRoles',
      'owner',
    ]);
  });

  it('applies a per-entry override to a subcommand group by its path', () => {
    const grouped = helpCommand(
      new SlashCommandBuilder()
        .setName('cfg')
        .setDescription('c')
        .addSubcommand((sub) => sub.setName('view').setDescription('v'))
        .addSubcommandGroup((group) =>
          group
            .setName('set')
            .setDescription('s')
            .addSubcommand((sub) => sub.setName('a').setDescription('a'))
        ),
      {
        category: DEMO,
        subcommandPermissions: {
          'cfg set': 'manageGuild',
          'cfg set a': 'owner',
        },
      }
    );

    expect(
      entriesOf(grouped).map((e) => [e.name, e.requiredPermission])
    ).toEqual([
      ['cfg view', 'everyone'],
      // Keyed by the listed path; a leaf path does not match.
      ['cfg set', 'manageGuild'],
    ]);
  });
});

describe('catalog categories', () => {
  const named = (name: string, category: CommandHelp['category']) =>
    helpCommand(new SlashCommandBuilder().setName(name).setDescription(name), {
      category,
    });

  it('orders categories by first appearance and keeps load order inside', () => {
    const categories = buildHelpCatalog([
      named('b1', { en: 'B', ja: 'ビー' }),
      named('a1', { en: 'A', ja: 'エー' }),
      named('b2', { en: 'B', ja: 'ビー' }),
    ]);

    expect(
      categories.map((c) => [c.name.en, c.commands.map((cmd) => cmd.name)])
    ).toEqual([
      ['B', ['b1', 'b2']],
      ['A', ['a1']],
    ]);
  });

  it('merges categories by English name, keeping the first Japanese name', () => {
    const categories = buildHelpCatalog([
      named('x', { en: 'Tools', ja: 'ツール' }),
      named('y', { en: 'Tools', ja: '道具' }),
    ]);

    expect(categories).toHaveLength(1);
    expect(categories[0].name).toEqual({ en: 'Tools', ja: 'ツール' });
  });

  it('accepts any iterable of commands, such as a collection view', () => {
    const loaded = new Map([
      ['one', named('one', DEMO)],
      ['two', named('two', DEMO)],
    ]);

    expect(
      buildHelpCatalog(loaded.values())[0].commands.map((c) => c.name)
    ).toEqual(['one', 'two']);
  });

  it('is empty when no command declares help metadata', () => {
    const silent = helpCommand(
      new SlashCommandBuilder().setName('silent').setDescription('s')
    );

    expect(buildHelpCatalog([silent])).toEqual([]);
    expect(buildHelpCatalog([])).toEqual([]);
  });
});
