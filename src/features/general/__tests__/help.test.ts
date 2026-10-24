import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type APIEmbed,
} from 'discord.js';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  autocompleteHelpCommand,
  executeHelpCommand,
} from '../application/help.js';
import { discoverFeatureCommands } from '../../../app/interactions/commandRegistry.js';
import {
  buildHelpCatalog,
  type CommandCategory,
  type CommandInfo,
  type LocalizedText,
} from '../../../shared/help/catalog.js';
import type { Command } from '../../../shared/types/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { COLORS } from '../../../shared/utils/constants/index.js';
import { logger } from '../../../shared/utils/logger.js';
import {
  OTHER_USER_ID,
  OWNER_ID,
  USER_ID,
  autocompleteInteraction,
  buttonComponent,
  chatInteraction,
  embedAt,
  embedTextLength,
  helpCommand,
  panelReply,
  payloadAt,
  selectComponent,
  selectMenuAt,
  type ChatInteractionOptions,
} from './general.helpers.js';

/**
 * `/general help` lists what the asker may run, grouped by category, with a
 * select menu to narrow the list; `/general help command:<name>` shows one
 * entry. The catalog comes from the client's loaded commands, so the fixtures
 * are real SlashCommandBuilders and the panel runs on the real
 * `runComponentPanel` against a captured collector.
 */

vi.mock('../../../shared/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  getErrorMessage: (e: unknown) => String(e),
}));

// Discovering the real commands imports every feature; keep any accidental
// query off data/*.db.
vi.mock('../../../infrastructure/database/connection.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  return {
    database: new Database(':memory:'),
    closeDatabase: vi.fn(),
    getTableCount: vi.fn(() => 0),
  };
});

const resolveLocale = vi.hoisted(() => vi.fn());
vi.mock('../../../locales/guildLocale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../locales/guildLocale.js')>()),
  resolveLocale,
}));

// The real config, loaded with a known owner (OWNER_ID in general.helpers).
vi.mock('../../../config/env.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/env.js')>();
  actual.loadConfig({ BOT_OWNER_IDS: 'owner-1' });
  return actual;
});

const NOW = new Date('2026-05-01T12:00:00Z');
const MANAGE_BOTH =
  PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles;

const GENERAL: LocalizedText = { en: 'General', ja: '一般' };
const COMMUNITY: LocalizedText = { en: 'Community', ja: 'コミュニティ' };
const ADMIN: LocalizedText = { en: 'Admin', ja: '管理者' };
const OWNER: LocalizedText = { en: 'Owner', ja: 'オーナー' };

const alpha = helpCommand(
  new SlashCommandBuilder()
    .setName('alpha')
    .setDescription('Alpha tools')
    .addSubcommand((sub) =>
      sub
        .setName('one')
        .setDescription('First thing')
        .setDescriptionLocalizations({ ja: '一つ目' })
    )
    .addSubcommandGroup((group) =>
      group
        .setName('grp')
        .setDescription('Grouped things')
        .setDescriptionLocalizations({ ja: 'グループ' })
        .addSubcommand((sub) => sub.setName('x').setDescription('x'))
        .addSubcommand((sub) => sub.setName('y').setDescription('y'))
    ),
  { category: GENERAL }
);

const fun = helpCommand(
  new SlashCommandBuilder()
    .setName('fun')
    .setDescription('Have fun')
    .setDescriptionLocalizations({ ja: '楽しむ' }),
  { category: COMMUNITY }
);

// Permission derived from the builder's default member permission.
const mod = helpCommand(
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderate the server')
    .setDescriptionLocalizations({ ja: 'サーバーを管理' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  { category: ADMIN }
);

// Either permission is enough.
const roles = helpCommand(
  new SlashCommandBuilder()
    .setName('roles')
    .setDescription('Manage roles')
    .setDescriptionLocalizations({ ja: 'ロールを管理' }),
  { category: ADMIN, permission: ['manageGuild', 'manageRoles'] }
);

const secret = helpCommand(
  new SlashCommandBuilder()
    .setName('secret')
    .setDescription('Owner tools')
    .setDescriptionLocalizations({ ja: 'オーナー用' }),
  { category: OWNER, permission: 'owner' }
);

// No help metadata: deployed, but never listed.
const hidden = helpCommand(
  new SlashCommandBuilder().setName('hidden').setDescription('Not listed')
);

const ALL_COMMANDS = [alpha, fun, mod, roles, secret, hidden];

/** One overview/category line as help renders it. */
function line(
  name: string,
  description: string,
  permissionKeys: Array<'manageGuild' | 'manageRoles' | 'owner'> = [],
  locale: Locale = 'en'
): string {
  const labels = permissionKeys.map((key) =>
    t(`help.permission.${key}`, locale)
  );
  const suffix = labels.length > 0 ? ` [${labels.join(', ')}]` : '';
  return `\`/${name}\` - ${description}${suffix}`;
}

function field(name: string, lines: string[]) {
  return { name, value: lines.join('\n'), inline: false };
}

async function runHelp(options: ChatInteractionOptions = {}) {
  const stub = chatInteraction({ commands: ALL_COMMANDS, ...options });
  await executeHelpCommand(stub.interaction);
  return stub;
}

/** Open the overview as a panel and return its collector handles. */
async function openPanel(options: ChatInteractionOptions = {}) {
  const panel = panelReply();
  const stub = await runHelp({ reply: panel.reply, ...options });
  return { ...stub, ...panel };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/general help overview', () => {
  it('replies publicly with every visible category and a category select', async () => {
    const { reply, interaction } = await openPanel();

    expect(resolveLocale).toHaveBeenCalledWith(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = payloadAt(reply);
    expect(payload.flags).toBeUndefined();
    expect(payload.withResponse).toBe(true);

    expect(embedAt(reply)).toMatchObject({
      title: t('help.title', 'en'),
      description: t('help.description', 'en'),
      color: COLORS.PRIMARY,
      footer: { text: t('help.filteredFooter', 'en') },
      fields: [
        field('General', [
          line('alpha one', 'First thing'),
          line('alpha grp', 'Grouped things'),
        ]),
        field('Community', [line('fun', 'Have fun')]),
      ],
    });
  });

  it('offers "show all" plus one option per visible category', async () => {
    const { reply } = await openPanel();

    const menu = selectMenuAt(reply);
    expect(menu.custom_id).toBe('help_category');
    expect(menu.placeholder).toBe(t('help.selectCategory', 'en'));
    expect(menu.disabled).toBe(false);
    expect(menu.options).toEqual([
      { label: t('help.showAll', 'en'), value: 'all', default: true },
      { label: 'General', value: 'cat_0', default: false },
      { label: 'Community', value: 'cat_1', default: false },
    ]);
  });

  it('hides restricted and owner-only commands from a plain member', async () => {
    const { reply } = await openPanel({ permissions: 0n });

    const text = JSON.stringify(embedAt(reply));
    expect(text).not.toContain('/mod');
    expect(text).not.toContain('/roles');
    expect(text).not.toContain('/secret');
    expect(text).not.toContain('/hidden');
  });

  it('shows Manage Server commands to members holding it, with a permission tag', async () => {
    const { reply } = await openPanel({
      permissions: PermissionFlagsBits.ManageGuild,
    });

    expect(embedAt(reply).fields).toContainEqual(
      field('Admin', [
        line('mod', 'Moderate the server', ['manageGuild']),
        line('roles', 'Manage roles', ['manageGuild', 'manageRoles']),
      ])
    );
    expect(JSON.stringify(embedAt(reply))).not.toContain('/secret');
  });

  it('shows only the commands Manage Roles unlocks to members holding just that', async () => {
    const { reply } = await openPanel({
      permissions: PermissionFlagsBits.ManageRoles,
    });

    expect(embedAt(reply).fields).toContainEqual(
      field('Admin', [
        line('roles', 'Manage roles', ['manageGuild', 'manageRoles']),
      ])
    );
  });

  it('treats Administrator as holding Manage Server', async () => {
    const { reply } = await openPanel({
      permissions: PermissionFlagsBits.Administrator,
    });

    expect(embedAt(reply).fields?.map((f) => f.name)).toContain('Admin');
  });

  it('shows owner-only commands to the bot owner, but not guild-only ones in DMs', async () => {
    const { reply } = await openPanel({ userId: OWNER_ID, inGuild: false });

    const embed = embedAt(reply);
    expect(embed.fields?.map((f) => f.name)).toEqual([
      'General',
      'Community',
      'Owner',
    ]);
    expect(embed.fields).toContainEqual(
      field('Owner', [line('secret', 'Owner tools', ['owner'])])
    );
  });

  it('shows everything to an owner who also manages the server', async () => {
    const { reply } = await openPanel({
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
    });

    expect(selectMenuAt(reply).options.map((o) => o.label)).toEqual([
      t('help.showAll', 'en'),
      'General',
      'Community',
      'Admin',
      'Owner',
    ]);
  });

  it('hides guild-permission commands when the member object is missing', async () => {
    const { reply } = await openPanel({ permissions: null });

    expect(embedAt(reply).fields?.map((f) => f.name)).toEqual([
      'General',
      'Community',
    ]);
  });

  it('renders categories, descriptions and permission tags in Japanese', async () => {
    resolveLocale.mockReturnValue('ja');

    const { reply } = await openPanel({
      permissions: PermissionFlagsBits.ManageGuild,
    });

    expect(embedAt(reply)).toMatchObject({
      title: t('help.title', 'ja'),
      description: t('help.description', 'ja'),
      footer: { text: t('help.filteredFooter', 'ja') },
      fields: [
        field('一般', [
          line('alpha one', '一つ目'),
          line('alpha grp', 'グループ'),
        ]),
        field('コミュニティ', [line('fun', '楽しむ')]),
        field('管理者', [
          line('mod', 'サーバーを管理', ['manageGuild'], 'ja'),
          line('roles', 'ロールを管理', ['manageGuild', 'manageRoles'], 'ja'),
        ]),
      ],
    });
    const menu = selectMenuAt(reply);
    expect(menu.placeholder).toBe(t('help.selectCategory', 'ja'));
    expect(menu.options.map((o) => o.label)).toEqual([
      t('help.showAll', 'ja'),
      '一般',
      'コミュニティ',
      '管理者',
    ]);
  });

  it('does not tag commands explicitly open to everyone', async () => {
    const open = helpCommand(
      new SlashCommandBuilder().setName('open').setDescription('Open to all'),
      { category: GENERAL, permission: ['everyone'] }
    );

    const { reply } = await runHelp({ commands: [open] });

    expect(embedAt(reply).fields).toEqual([
      field('General', [line('open', 'Open to all')]),
    ]);
  });

  it('falls back to the English description when a command has no ja text', async () => {
    resolveLocale.mockReturnValue('ja');
    const englishOnly = helpCommand(
      new SlashCommandBuilder().setName('plain').setDescription('Only English'),
      { category: GENERAL }
    );

    const { reply } = await runHelp({ commands: [englishOnly] });

    expect(embedAt(reply).fields).toEqual([
      field('一般', [line('plain', 'Only English')]),
    ]);
  });

  it('replies without a select when only one category is visible', async () => {
    const panel = panelReply();

    await runHelp({ commands: [alpha, mod], reply: panel.reply });

    const payload = payloadAt(panel.reply);
    expect(payload.components).toBeUndefined();
    expect(payload.withResponse).toBeUndefined();
    expect(embedAt(panel.reply).fields?.map((f) => f.name)).toEqual([
      'General',
    ]);
    expect(panel.createMessageComponentCollector).not.toHaveBeenCalled();
  });

  it('replies with an empty overview when the asker can see nothing', async () => {
    const { reply } = await runHelp({ commands: [secret, hidden] });

    const embed = embedAt(reply);
    expect(embed.title).toBe(t('help.title', 'en'));
    expect(embed.fields ?? []).toEqual([]);
    expect(payloadAt(reply).components).toBeUndefined();
  });

  it('replies with an empty overview when no commands are loaded', async () => {
    const { reply } = await runHelp({ commands: [] });

    expect(embedAt(reply).fields ?? []).toEqual([]);
  });

  it('propagates a rejected reply to the caller', async () => {
    const reply = vi.fn().mockRejectedValue(new Error('Unknown interaction'));

    await expect(runHelp({ reply })).rejects.toThrow('Unknown interaction');
  });
});

describe('/general help category panel', () => {
  it('collects only string-select interactions', async () => {
    const { createMessageComponentCollector } = await openPanel();

    expect(createMessageComponentCollector).toHaveBeenCalledWith(
      expect.objectContaining({ componentType: ComponentType.StringSelect })
    );
  });

  it('switches to a single category when one is selected', async () => {
    const { collect } = await openPanel({
      permissions: PermissionFlagsBits.ManageGuild,
    });
    const component = selectComponent(['cat_2']);

    await collect(component);

    expect(component.reply).not.toHaveBeenCalled();
    expect(component.update).toHaveBeenCalledTimes(1);
    expect(embedAt(component.update)).toMatchObject({
      title: 'Admin',
      description: [
        line('mod', 'Moderate the server', ['manageGuild']),
        line('roles', 'Manage roles', ['manageGuild', 'manageRoles']),
      ].join('\n'),
      color: COLORS.PRIMARY,
      footer: { text: t('help.filteredFooter', 'en') },
    });
    expect(embedAt(component.update).fields).toBeUndefined();

    const options = selectMenuAt(component.update).options;
    expect(options.find((o) => o.default)?.value).toBe('cat_2');
    expect(options.filter((o) => o.default)).toHaveLength(1);
  });

  it('renders the selected category in Japanese', async () => {
    resolveLocale.mockReturnValue('ja');
    const { collect } = await openPanel();
    const component = selectComponent(['cat_0']);

    await collect(component);

    expect(embedAt(component.update)).toMatchObject({
      title: '一般',
      description: [
        line('alpha one', '一つ目'),
        line('alpha grp', 'グループ'),
      ].join('\n'),
      footer: { text: t('help.filteredFooter', 'ja') },
    });
  });

  it('returns to the overview when "show all" is selected', async () => {
    const { collect } = await openPanel();
    const toCategory = selectComponent(['cat_1']);
    const toAll = selectComponent(['all']);

    await collect(toCategory);
    await collect(toAll);

    expect(embedAt(toCategory.update).title).toBe('Community');
    expect(embedAt(toAll.update).title).toBe(t('help.title', 'en'));
    expect(embedAt(toAll.update).fields).toHaveLength(2);
    expect(
      selectMenuAt(toAll.update).options.find((o) => o.default)?.value
    ).toBe('all');
  });

  it.each([['cat_9'], ['cat_-1'], ['bogus']])(
    'answers an unknown category value %s privately and keeps the view',
    async (value) => {
      const { collect, end, editReply } = await openPanel();
      const component = selectComponent([value]);

      await collect(component);

      expect(component.update).not.toHaveBeenCalled();
      expect(component.reply).toHaveBeenCalledWith({
        content: t('help.commandNotFoundDesc', 'en', { command: value }),
        flags: MessageFlags.Ephemeral,
      });

      // The selection is unchanged: the expired panel still marks "all".
      await end();
      expect(
        selectMenuAt(editReply).options.find((o) => o.default)?.value
      ).toBe('all');
    }
  );

  it('ignores components that are not the category select', async () => {
    const { collect } = await openPanel();
    const component = buttonComponent();

    await collect(component);

    expect(component.update).not.toHaveBeenCalled();
    expect(component.reply).not.toHaveBeenCalled();
    expect(component.deferUpdate).not.toHaveBeenCalled();
  });

  it('refuses the select for anyone but the person who ran the command', async () => {
    const { collect } = await openPanel({ userId: USER_ID });
    const component = selectComponent(['cat_1'], OTHER_USER_ID);

    await collect(component);

    expect(component.update).not.toHaveBeenCalled();
    expect(component.reply).toHaveBeenCalledWith({
      content: t('help.onlyCommandUser', 'en'),
      flags: MessageFlags.Ephemeral,
    });
  });

  it('acknowledges the select when Discord rejects the update', async () => {
    const { collect } = await openPanel();
    const component = selectComponent(['cat_1']);
    component.update.mockRejectedValueOnce(new Error('Unknown message'));

    await collect(component);

    expect(component.deferUpdate).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('help panel')
    );
  });

  it('disables the select, keeping the current choice, when the panel expires', async () => {
    const { collect, end, editReply } = await openPanel();

    await collect(selectComponent(['cat_1']));
    await end();

    expect(editReply).toHaveBeenCalledTimes(1);
    expect(payloadAt(editReply).embeds).toBeUndefined();
    const menu = selectMenuAt(editReply);
    expect(menu.disabled).toBe(true);
    expect(menu.options.find((o) => o.default)?.value).toBe('cat_1');
  });
});

describe('/general help command:<name>', () => {
  it('shows the description and usage of a visible command', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha one' });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(payloadAt(reply).flags).toBeUndefined();
    expect(payloadAt(reply).components).toBeUndefined();
    expect(embedAt(reply)).toEqual({
      title: '/alpha one',
      description: 'First thing',
      color: COLORS.PRIMARY,
      fields: [
        { name: t('help.usage', 'en'), value: '`/alpha one`', inline: false },
      ],
      timestamp: NOW.toISOString(),
    });
  });

  it('lists every leaf of a subcommand group as its usage', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha grp' });

    expect(embedAt(reply).fields?.[0].value).toBe(
      '`/alpha grp x, /alpha grp y`'
    );
  });

  it('renders the detail in Japanese', async () => {
    resolveLocale.mockReturnValue('ja');

    const { reply } = await runHelp({ commandOption: 'alpha grp' });

    expect(embedAt(reply)).toMatchObject({
      title: '/alpha grp',
      description: 'グループ',
      fields: [{ name: t('help.usage', 'ja') }],
    });
  });

  it.each<Locale>(['en', 'ja'])(
    'reports an unknown command as not found (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);

      const { reply } = await runHelp({ commandOption: 'nope' });

      expect(embedAt(reply)).toMatchObject({
        title: t('help.commandNotFound', locale),
        description: t('help.commandNotFoundDesc', locale, {
          command: 'nope',
        }),
        color: COLORS.WARNING,
      });
    }
  );

  it('does not reveal a command the asker may not use', async () => {
    const asMember = await runHelp({ commandOption: 'secret' });
    const asOwner = await runHelp({
      commandOption: 'secret',
      userId: OWNER_ID,
    });

    expect(embedAt(asMember.reply).title).toBe(t('help.commandNotFound', 'en'));
    expect(embedAt(asOwner.reply).title).toBe('/secret');
  });

  it('requires the guild permission for a restricted command', async () => {
    const asMember = await runHelp({ commandOption: 'mod' });
    const asManager = await runHelp({
      commandOption: 'mod',
      permissions: PermissionFlagsBits.ManageGuild,
    });

    expect(embedAt(asMember.reply).title).toBe(t('help.commandNotFound', 'en'));
    expect(embedAt(asManager.reply).title).toBe('/mod');
  });

  it('does not list a command that declares no help metadata', async () => {
    const { reply } = await runHelp({
      commandOption: 'hidden',
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
    });

    expect(embedAt(reply).title).toBe(t('help.commandNotFound', 'en'));
  });

  it('leaves out the usage field when an entry has no usage', async () => {
    // A group with no subcommands has no leaves, so nothing to show.
    const hollow = helpCommand(
      new SlashCommandBuilder()
        .setName('hollow')
        .setDescription('h')
        .addSubcommandGroup((group) =>
          group.setName('empty').setDescription('Nothing yet')
        ),
      { category: GENERAL }
    );

    const { reply } = await runHelp({
      commands: [hollow],
      commandOption: 'hollow empty',
    });

    expect(embedAt(reply)).toMatchObject({
      title: '/hollow empty',
      description: 'Nothing yet',
    });
    expect(embedAt(reply).fields).toBeUndefined();
  });

  it('matches only full entry names', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha' });

    expect(embedAt(reply).title).toBe(t('help.commandNotFound', 'en'));
  });
});

describe('/general help autocomplete', () => {
  async function suggest(
    options: Parameters<typeof autocompleteInteraction>[0] = {}
  ) {
    const stub = autocompleteInteraction({
      commands: ALL_COMMANDS,
      ...options,
    });
    await autocompleteHelpCommand(stub.interaction);
    expect(stub.respond).toHaveBeenCalledTimes(1);
    return stub.respond.mock.calls[0][0] as Array<{
      name: string;
      value: string;
    }>;
  }

  it('suggests visible entries starting with the typed text, ignoring case', async () => {
    const choices = await suggest({ focused: 'AL' });

    expect(choices).toEqual([
      { name: 'alpha one - First thing', value: 'alpha one' },
      { name: 'alpha grp - Grouped things', value: 'alpha grp' },
    ]);
  });

  it('suggests every visible entry for an empty query and nothing restricted', async () => {
    const choices = await suggest({ focused: '' });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
    ]);
  });

  it('includes restricted entries for those allowed to see them', async () => {
    const choices = await suggest({
      focused: '',
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
    });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
      'mod',
      'roles',
      'secret',
    ]);
  });

  it('labels suggestions with the Japanese description for ja', async () => {
    resolveLocale.mockReturnValue('ja');

    const choices = await suggest({ focused: 'alpha o' });

    expect(choices).toEqual([
      { name: 'alpha one - 一つ目', value: 'alpha one' },
    ]);
  });

  it('responds with no choices when nothing matches', async () => {
    expect(await suggest({ focused: 'zzz' })).toEqual([]);
  });

  it('shortens descriptions longer than 60 characters', async () => {
    const long = 'L'.repeat(61);
    const exact = 'E'.repeat(60);
    const wordy = helpCommand(
      new SlashCommandBuilder()
        .setName('wordy')
        .setDescription('d')
        .addSubcommand((sub) => sub.setName('long').setDescription(long))
        .addSubcommand((sub) => sub.setName('exact').setDescription(exact)),
      { category: GENERAL }
    );

    const choices = await suggest({ commands: [wordy], focused: 'wordy' });

    expect(choices).toEqual([
      { name: `wordy long - ${'L'.repeat(59)}...`, value: 'wordy long' },
      { name: `wordy exact - ${exact}`, value: 'wordy exact' },
    ]);
  });

  it('returns at most 25 choices', async () => {
    const many = (name: string) =>
      helpCommand(
        new SlashCommandBuilder()
          .setName(name)
          .setDescription('d')
          .addSubcommand((sub) => sub.setName('s0').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s1').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s2').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s3').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s4').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s5').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s6').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s7').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s8').setDescription('d'))
          .addSubcommand((sub) => sub.setName('s9').setDescription('d')),
        { category: GENERAL }
      );

    const choices = await suggest({
      commands: [many('a'), many('b'), many('c')],
      focused: '',
    });

    expect(choices).toHaveLength(25);
    expect(choices[0].value).toBe('a s0');
    expect(choices[24].value).toBe('c s4');
  });
});

describe('/general help with the real command definitions', () => {
  const FEATURES_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
  );

  let commands: Command[];
  let catalog: CommandCategory[];
  let entries: CommandInfo[];

  beforeAll(async () => {
    const discovered = await discoverFeatureCommands(FEATURES_PATH);
    // A command module that fails to import would silently drop out of help.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();

    commands = discovered.map((item) => item.command);
    catalog = buildHelpCatalog(commands);
    entries = catalog.flatMap((category) => category.commands);
  });

  it('lists the general command itself', () => {
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['general help', 'general ping', 'general about'])
    );
  });

  it.each<Locale>(['en', 'ja'])(
    'renders a detail page for every catalog entry (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);
      expect(entries.length).toBeGreaterThan(0);

      for (const entry of entries) {
        const { reply } = await runHelp({
          commands,
          commandOption: entry.name,
          userId: OWNER_ID,
          permissions: MANAGE_BOTH,
        });

        const embed = embedAt(reply);
        expect(embed.title, entry.name).toBe(`/${entry.name}`);
        expect(embed.description, entry.name).toBe(entry.description[locale]);
        expect(embed.description?.length, entry.name).toBeGreaterThan(0);
        expect(embed.fields, entry.name).toEqual([
          {
            name: t('help.usage', locale),
            value: `\`${entry.usage}\``,
            inline: false,
          },
        ]);
        expect(entry.usage, entry.name).toMatch(new RegExp(`^/${entry.name}`));
      }
    }
  );

  it.each<Locale>(['en', 'ja'])(
    'fits the full overview into one embed Discord accepts (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);

      const { reply } = await openPanel({
        commands,
        userId: OWNER_ID,
        permissions: MANAGE_BOTH,
      });

      const embed = embedAt(reply);
      expect(embedTextLength(embed)).toBeLessThanOrEqual(6000);
      expect(embed.fields).toHaveLength(catalog.length);
      for (const [index, category] of catalog.entries()) {
        const value = embed.fields?.[index].value ?? '';
        expect(embed.fields?.[index].name).toBe(category.name[locale]);
        expect(value.length).toBeLessThanOrEqual(1024);
        // Nothing was cut off by the per-field truncation.
        for (const cmd of category.commands) {
          expect(value, cmd.name).toContain(`\`/${cmd.name}\``);
        }
      }
      expect(selectMenuAt(reply).options).toHaveLength(catalog.length + 1);
    }
  );

  it.each<Locale>(['en', 'ja'])(
    'renders every category page within embed limits (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);
      const { collect } = await openPanel({
        commands,
        userId: OWNER_ID,
        permissions: MANAGE_BOTH,
      });

      for (const [index, category] of catalog.entries()) {
        const component = selectComponent([`cat_${index}`], OWNER_ID);
        await collect(component);

        const embed: APIEmbed = embedAt(component.update);
        expect(embed.title).toBe(category.name[locale]);
        expect(embed.description?.split('\n')).toHaveLength(
          category.commands.length
        );
      }
    }
  );

  it('never shows /owner entries to someone who is not a bot owner', async () => {
    const { reply } = await openPanel({
      commands,
      userId: USER_ID,
      permissions: MANAGE_BOTH,
    });

    const ownerEntries = entries.filter((e) => e.name.startsWith('owner '));
    expect(ownerEntries.length).toBeGreaterThan(0);
    expect(JSON.stringify(embedAt(reply))).not.toContain('`/owner ');

    const suggestions = autocompleteInteraction({
      commands,
      userId: USER_ID,
      permissions: MANAGE_BOTH,
      focused: 'owner',
    });
    await autocompleteHelpCommand(suggestions.interaction);
    expect(suggestions.respond).toHaveBeenCalledWith([]);
  });

  it.each<Locale>(['en', 'ja'])(
    'keeps every autocomplete choice within Discord’s 100-character limit (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);
      const choices: Array<{ name: string; value: string }> = [];

      // Query per entry: one empty query would stop at 25 choices.
      for (const entry of entries) {
        const stub = autocompleteInteraction({
          commands,
          userId: OWNER_ID,
          permissions: MANAGE_BOTH,
          focused: entry.name,
        });
        await autocompleteHelpCommand(stub.interaction);
        choices.push(...(stub.respond.mock.calls[0][0] as typeof choices));
      }

      expect(choices.map((c) => c.value)).toEqual(
        expect.arrayContaining(entries.map((e) => e.name))
      );
      for (const choice of choices) {
        expect(choice.name.length, choice.name).toBeLessThanOrEqual(100);
        expect(choice.value.length, choice.value).toBeLessThanOrEqual(100);
      }
    }
  );

  it('shows /owner entries to the bot owner, tagged as owner-only', async () => {
    const { reply } = await openPanel({ commands, userId: OWNER_ID });

    const ownerTag = ` [${t('help.permission.owner', 'en')}]`;
    const text = (embedAt(reply).fields ?? []).map((f) => f.value).join('\n');
    for (const entry of entries.filter((e) => e.name.startsWith('owner '))) {
      expect(text).toContain(
        `\`/${entry.name}\` - ${entry.description.en}${ownerTag}`
      );
    }
  });
});
