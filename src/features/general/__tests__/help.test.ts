import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  type APIButtonComponent,
  type APIEmbed,
  type APIStringSelectComponent,
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
  clearCommandIds,
  setCommandIds,
} from '../../../shared/utils/commandMentions.js';
import { cooldownStore } from '../../../middleware/cooldown/index.js';
import {
  OTHER_USER_ID,
  OWNER_ID,
  USER_ID,
  autocompleteInteraction,
  buttonComponent,
  chatInteraction,
  commandSelect,
  componentAt,
  componentsAt,
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
 * `/general help` lists what the asker may run, grouped by category, with
 * menus to narrow the list and open one command in place;
 * `/general help command:<text>` finds one entry by path, word or
 * description. The catalog comes from the client's loaded commands, so the
 * fixtures are real SlashCommandBuilders and the panel runs on the real
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
const EPHEMERAL = MessageFlags.Ephemeral;

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

/** One overview/category line as help renders it (no command ids known). */
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
  const stub = chatInteraction({
    commands: ALL_COMMANDS,
    subcommand: 'help',
    ...options,
  });
  await executeHelpCommand(stub.interaction);
  return stub;
}

/** Open the overview as a panel and return its collector handles. */
async function openPanel(options: ChatInteractionOptions = {}) {
  const panel = panelReply();
  const stub = await runHelp({ reply: panel.reply, ...options });
  return { ...stub, ...panel };
}

/** The "not found" description help sends for `query`. */
function noMatchText(query: string, locale: Locale = 'en', guess?: string) {
  return [
    t('help.noMatch', locale, { query }),
    ...(guess ? [t('help.didYouMean', locale, { suggestion: guess })] : []),
    '',
    t('help.noMatchHint', locale, { help: '`/general help`' }),
  ].join('\n');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  clearCommandIds();
  resolveLocale.mockReturnValue('en');
});

afterEach(() => {
  cooldownStore.clearCooldown('general help', USER_ID);
  clearCommandIds();
  vi.useRealTimers();
});

describe('/general help overview', () => {
  it('replies privately with every visible category and a category select', async () => {
    const { reply, interaction } = await openPanel();

    expect(resolveLocale).toHaveBeenCalledWith(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    const payload = payloadAt(reply);
    expect(payload.flags).toBe(EPHEMERAL);
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

  it('shows the overview to the whole channel when public is chosen', async () => {
    const { reply } = await openPanel({ publicOption: true });

    expect(payloadAt(reply).flags).toBeUndefined();
    expect(embedAt(reply).title).toBe(t('help.title', 'en'));
  });

  it('stays private when public is explicitly false', async () => {
    const { reply } = await openPanel({ publicOption: false });

    expect(payloadAt(reply).flags).toBe(EPHEMERAL);
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

  it('offers a command menu with every visible entry and nothing restricted', async () => {
    const { reply } = await openPanel();

    const menu = componentAt(reply, 'help_command');
    expect(menu?.placeholder).toBe(t('help.selectCommand', 'en'));
    expect(menu?.options).toEqual([
      {
        label: '/alpha one',
        value: 'alpha one',
        description: 'First thing',
        default: false,
      },
      {
        label: '/alpha grp',
        value: 'alpha grp',
        description: 'Grouped things',
        default: false,
      },
      { label: '/fun', value: 'fun', description: 'Have fun', default: false },
    ]);
    expect(componentAt(reply, 'help_back')).toBeUndefined();
  });

  it('turns runnable entries into tappable mentions once command ids are known', async () => {
    setCommandIds([
      { name: 'alpha', id: '111' },
      { name: 'fun', id: '222' },
    ]);

    const { reply } = await openPanel();

    expect(embedAt(reply).fields).toEqual([
      field('General', [
        '</alpha one:111> - First thing',
        // A group cannot be mentioned, only its subcommands.
        '`/alpha grp` - Grouped things',
      ]),
      field('Community', ['</fun:222> - Have fun']),
    ]);
  });

  it('hides restricted and owner-only commands from a plain member', async () => {
    const { reply } = await openPanel({ permissions: 0n });

    const text = JSON.stringify([embedAt(reply), componentsAt(reply)]);
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
    expect(
      componentAt(reply, 'help_command')?.options.map((o) => o.description)
    ).toEqual([
      '一つ目',
      'グループ',
      '楽しむ',
      'サーバーを管理',
      'ロールを管理',
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

  it('offers only the command menu when one category is visible', async () => {
    const { reply } = await openPanel({ commands: [alpha, mod] });

    expect(embedAt(reply).fields?.map((f) => f.name)).toEqual(['General']);
    expect(componentsAt(reply).map((c) => c.custom_id)).toEqual([
      'help_command',
    ]);
  });

  it('replies with an empty overview and no panel when the asker can see nothing', async () => {
    const panel = panelReply();
    const { reply } = await runHelp({
      commands: [secret, hidden],
      reply: panel.reply,
    });

    const embed = embedAt(reply);
    expect(embed.title).toBe(t('help.title', 'en'));
    // No menu, so no "pick one from the menu below".
    expect(embed.description).toBe(t('help.descriptionNoMenu', 'en'));
    expect(embed.fields ?? []).toEqual([]);
    expect(payloadAt(reply).components).toBeUndefined();
    expect(payloadAt(reply).flags).toBe(EPHEMERAL);
    expect(panel.createMessageComponentCollector).not.toHaveBeenCalled();
  });

  it('does not point at a menu when one category is too long for one', async () => {
    resolveLocale.mockReturnValue('ja');
    // 26 entries in a single category: no category menu, and more than a
    // select menu holds.
    const thirteen = (name: string) => {
      const builder = new SlashCommandBuilder()
        .setName(name)
        .setDescription('d');
      for (let i = 0; i < 13; i++) {
        builder.addSubcommand((sub) =>
          sub.setName(`s${i}`).setDescription('d')
        );
      }
      return helpCommand(builder, { category: GENERAL });
    };
    const panel = panelReply();

    const { reply } = await runHelp({
      commands: [thirteen('a'), thirteen('b')],
      reply: panel.reply,
    });

    expect(embedAt(reply).description).toBe(t('help.descriptionNoMenu', 'ja'));
    expect(embedAt(reply).fields?.[0].value.split('\n')).toHaveLength(26);
    expect(payloadAt(reply).components).toBeUndefined();
    expect(panel.createMessageComponentCollector).not.toHaveBeenCalled();
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

describe('/general help panel', () => {
  it('collects buttons as well as selects, so the back button works', async () => {
    const { createMessageComponentCollector } = await openPanel();

    const [options] = createMessageComponentCollector.mock
      .calls[0] as unknown as [{ componentType?: ComponentType }];
    expect(options.componentType).toBeUndefined();
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
    // The command menu narrows to the category.
    expect(
      componentAt(component.update, 'help_command')?.options.map((o) => o.value)
    ).toEqual(['mod', 'roles']);
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

  it('opens a command in place and goes back to the list it came from', async () => {
    const { collect } = await openPanel();
    await collect(selectComponent(['cat_0']));
    const pick = commandSelect('alpha grp');

    await collect(pick);

    expect(pick.reply).not.toHaveBeenCalled();
    expect(embedAt(pick.update)).toMatchObject({
      title: '/alpha grp',
      description: 'Grouped things',
      fields: [
        { name: 'x', value: '`/alpha grp x`', inline: false },
        { name: 'y', value: '`/alpha grp y`', inline: false },
      ],
    });
    expect(
      componentAt(pick.update, 'help_command')?.options.find((o) => o.default)
        ?.value
    ).toBe('alpha grp');
    expect(
      componentAt<APIButtonComponent>(pick.update, 'help_back')
    ).toMatchObject({ label: t('help.back', 'en'), disabled: false });

    const back = buttonComponent(USER_ID, 'help_back');
    await collect(back);

    expect(embedAt(back.update).title).toBe('General');
    expect(componentAt(back.update, 'help_back')).toBeUndefined();
    expect(
      selectMenuAt(back.update).options.find((o) => o.default)?.value
    ).toBe('cat_0');
  });

  it('opens a command straight from the overview', async () => {
    const { collect } = await openPanel();
    const pick = commandSelect('fun');

    await collect(pick);

    expect(embedAt(pick.update).title).toBe('/fun');
    const back = buttonComponent(USER_ID, 'help_back');
    await collect(back);
    expect(embedAt(back.update).title).toBe(t('help.title', 'en'));
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
        flags: EPHEMERAL,
      });

      // The selection is unchanged: the expired panel still marks "all".
      await end();
      expect(
        selectMenuAt(editReply).options.find((o) => o.default)?.value
      ).toBe('all');
    }
  );

  it.each([
    ['a command the asker cannot see', 'mod'],
    ['a command outside the selected category', 'fun'],
    ['nothing at all', 'ghost'],
  ])('refuses a command pick naming %s', async (_label, value) => {
    const { collect } = await openPanel();
    await collect(selectComponent(['cat_0']));
    const pick = commandSelect(value);

    await collect(pick);

    expect(pick.update).not.toHaveBeenCalled();
    expect(pick.reply).toHaveBeenCalledWith({
      content: t('help.commandNotFoundDesc', 'en', { command: value }),
      flags: EPHEMERAL,
    });
  });

  it('quietly acknowledges a component that is not one of its own', async () => {
    const { collect } = await openPanel();
    const component = buttonComponent();

    await collect(component);

    expect(component.update).not.toHaveBeenCalled();
    expect(component.reply).not.toHaveBeenCalled();
    expect(component.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it('points anyone but the person who ran it at their own /general help', async () => {
    const { collect } = await openPanel({
      userId: USER_ID,
      publicOption: true,
    });
    const component = selectComponent(['cat_1'], OTHER_USER_ID);

    await collect(component);

    expect(component.update).not.toHaveBeenCalled();
    expect(component.reply).toHaveBeenCalledWith({
      content: t('common.onlyCommandUser', 'en', {
        user: `<@${USER_ID}>`,
        command: '`/general help`',
      }),
      flags: EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  });

  it('reports a click Discord rejected, with a reference to the log', async () => {
    const { collect } = await openPanel();
    const component = selectComponent(['cat_1']);
    component.update.mockRejectedValueOnce(new Error('Unknown message'));

    await collect(component);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('help panel'),
      expect.anything()
    );
    const [id] = /\[([0-9a-f]{6})\]/
      .exec(String(vi.mocked(logger.warn).mock.calls[0][0]))!
      .slice(1);
    expect(component.reply).toHaveBeenCalledWith({
      content: t('common.actionFailed', 'en', { id }),
      flags: EPHEMERAL,
    });
  });

  it('disables every control, keeping the current choice, when the panel expires', async () => {
    const { collect, end, editReply } = await openPanel();

    await collect(selectComponent(['cat_1']));
    await collect(commandSelect('fun'));
    await end();

    expect(editReply).toHaveBeenCalledTimes(1);
    expect(payloadAt(editReply).embeds).toBeUndefined();
    expect(payloadAt(editReply).content).toBe(
      t('common.panelExpired', 'en', { command: '`/general help`' })
    );
    const controls = componentsAt(editReply);
    expect(controls.map((c) => c.custom_id)).toEqual([
      'help_category',
      'help_command',
      'help_back',
    ]);
    expect(controls.every((c) => c.disabled === true)).toBe(true);
    expect(selectMenuAt(editReply).options.find((o) => o.default)?.value).toBe(
      'cat_1'
    );
  });
});

describe('/general help command:<name>', () => {
  it('shows the description and usage of a visible command, privately', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha one' });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(payloadAt(reply).flags).toBe(EPHEMERAL);
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

  it('shows a detail to the channel when public is chosen', async () => {
    const { reply } = await runHelp({
      commandOption: 'alpha one',
      publicOption: true,
    });

    expect(payloadAt(reply).flags).toBeUndefined();
    expect(embedAt(reply).title).toBe('/alpha one');
  });

  it('gives each subcommand of a group its own line to tap', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha grp' });

    expect(embedAt(reply).fields).toEqual([
      { name: 'x', value: '`/alpha grp x`', inline: false },
      { name: 'y', value: '`/alpha grp y`', inline: false },
    ]);
  });

  it('mentions each runnable path once command ids are known', async () => {
    setCommandIds([{ name: 'alpha', id: '111' }]);

    const one = await runHelp({ commandOption: 'alpha one' });
    const grp = await runHelp({ commandOption: 'alpha grp' });

    expect(embedAt(one.reply).fields?.[0].value).toBe('</alpha one:111>');
    expect(embedAt(grp.reply).fields?.map((f) => f.value)).toEqual([
      '</alpha grp x:111>',
      '</alpha grp y:111>',
    ]);
  });

  it('renders the detail in Japanese', async () => {
    resolveLocale.mockReturnValue('ja');

    const { reply } = await runHelp({ commandOption: 'alpha one' });

    expect(embedAt(reply)).toMatchObject({
      title: '/alpha one',
      description: '一つ目',
      fields: [{ name: t('help.usage', 'ja') }],
    });
  });

  it('says which permission a restricted entry needs', async () => {
    const asManager = await runHelp({
      commandOption: 'mod',
      permissions: PermissionFlagsBits.ManageGuild,
    });
    const either = await runHelp({
      commandOption: 'roles',
      permissions: PermissionFlagsBits.ManageRoles,
    });

    expect(embedAt(asManager.reply).description).toBe(
      `Moderate the server\n\n${t('help.requires', 'en', { permissions: 'Manage Server' })}`
    );
    expect(embedAt(either.reply).description).toBe(
      `Manage roles\n\n${t('help.requires', 'en', { permissions: 'Manage Server or Manage Roles' })}`
    );
  });

  it('says in Japanese that either permission will do', async () => {
    resolveLocale.mockReturnValue('ja');

    const { reply } = await runHelp({
      commandOption: 'roles',
      permissions: PermissionFlagsBits.ManageRoles,
    });

    expect(embedAt(reply).description).toBe(
      `ロールを管理\n\n${t('help.requires', 'ja', { permissions: 'サーバー管理またはロールの管理' })}`
    );
  });

  describe('options and examples', () => {
    const many = Array.from({ length: 7 }, (_, i) => `c${i}`);
    const search = helpCommand(
      new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search things')
        .setDescriptionLocalizations({ ja: '検索する' })
        .addStringOption((o) =>
          o
            .setName('query')
            .setNameLocalizations({ ja: 'キーワード' })
            .setDescription('What to look for')
            .setDescriptionLocalizations({ ja: '探す言葉' })
            .setRequired(true)
        )
        .addStringOption((o) =>
          o
            .setName('sort')
            .setDescription('Order')
            .setDescriptionLocalizations({ ja: '並び順' })
            .addChoices(
              {
                name: 'Newest',
                value: 'new',
                name_localizations: { ja: '新しい順' },
              },
              {
                name: 'Oldest',
                value: 'old',
                name_localizations: { ja: '古い順' },
              }
            )
        )
        .addStringOption((o) =>
          o
            .setName('kind')
            .setDescription('Kind')
            .addChoices(...many.map((c) => ({ name: c, value: c })))
        ),
      {
        category: GENERAL,
        examples: {
          search: [
            {
              en: '`/search query:cats` find cats',
              ja: '`/search キーワード:猫` 猫を探す',
            },
          ],
        },
      }
    );

    it('lists every option with its requirement and short choice lists', async () => {
      const { reply } = await runHelp({
        commands: [search],
        commandOption: 'search',
      });

      expect(embedAt(reply).fields).toEqual([
        {
          name: t('help.usage', 'en'),
          value: [
            '`/search`',
            '• `query` (required): What to look for',
            '• `sort`: Order (choices: Newest / Oldest)',
            // Seven choices are too many to spell out.
            '• `kind`: Kind',
          ].join('\n'),
          inline: false,
        },
        {
          name: t('help.examples', 'en'),
          value: '`/search query:cats` find cats',
          inline: false,
        },
      ]);
    });

    it('uses the option and choice names a Japanese client shows', async () => {
      resolveLocale.mockReturnValue('ja');

      const { reply } = await runHelp({
        commands: [search],
        commandOption: 'search',
      });

      expect(embedAt(reply).fields).toEqual([
        {
          name: t('help.usage', 'ja'),
          value: [
            '`/search`',
            '・`キーワード`（必須）: 探す言葉',
            '・`sort`: 並び順（選択肢: 新しい順 / 古い順）',
            '・`kind`: Kind',
          ].join('\n'),
          inline: false,
        },
        {
          name: t('help.examples', 'ja'),
          value: '`/search キーワード:猫` 猫を探す',
          inline: false,
        },
      ]);
    });
  });

  it.each<Locale>(['en', 'ja'])(
    'answers a query that matches nothing privately, with a hint (%s)',
    async (locale) => {
      resolveLocale.mockReturnValue(locale);

      const { reply } = await runHelp({ commandOption: 'qqqq' });

      expect(reply).toHaveBeenCalledTimes(1);
      expect(payloadAt(reply).flags).toBe(EPHEMERAL);
      expect(payloadAt(reply).components).toBeUndefined();
      expect(embedAt(reply)).toMatchObject({
        title: t('help.commandNotFound', locale),
        description: noMatchText('qqqq', locale),
        color: COLORS.WARNING,
      });
    }
  );

  it('keeps a miss private even when public is chosen', async () => {
    const { reply } = await runHelp({
      commandOption: 'qqqq',
      publicOption: true,
    });

    expect(payloadAt(reply).flags).toBe(EPHEMERAL);
  });

  it('guesses at a typo', async () => {
    const { reply } = await runHelp({ commandOption: 'fnu' });

    expect(embedAt(reply).description).toBe(noMatchText('fnu', 'en', '`/fun`'));
  });

  it('never guesses a command the asker may not use', async () => {
    const { reply } = await runHelp({ commandOption: 'secrte' });

    expect(embedAt(reply).description).toBe(noMatchText('secrte'));
  });

  it('echoes the query without backticks and at bounded length', async () => {
    const { reply } = await runHelp({
      commandOption: `\`q\`${'q'.repeat(80)}`,
    });

    const echoed = `${'q'.repeat(49)}…`;
    expect(embedAt(reply).description).toBe(noMatchText(echoed));
  });

  it('frees the cooldown after a miss so a corrected retry is not refused', async () => {
    cooldownStore.setCooldown('general help', USER_ID, 3000);
    await runHelp({ commandOption: 'qqqq' });
    expect(cooldownStore.checkCooldown('general help', USER_ID)).toBe(0);

    cooldownStore.setCooldown('general help', USER_ID, 3000);
    await runHelp({ commandOption: 'fun' });
    expect(
      cooldownStore.checkCooldown('general help', USER_ID)
    ).toBeGreaterThan(0);
  });

  it('does not reveal a command the asker may not use', async () => {
    const asMember = await runHelp({ commandOption: 'secret' });
    const unknown = await runHelp({ commandOption: 'qqqqqq' });
    const asOwner = await runHelp({
      commandOption: 'secret',
      userId: OWNER_ID,
    });

    // Indistinguishable from an unknown command, down to the reply flags.
    expect(embedAt(asMember.reply)).toMatchObject({
      title: t('help.commandNotFound', 'en'),
      description: noMatchText('secret'),
      color: COLORS.WARNING,
    });
    expect(payloadAt(asMember.reply).flags).toBe(
      payloadAt(unknown.reply).flags
    );
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

  it('leaves out the usage field when an entry has nothing to run', async () => {
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

  it.each([
    ['a word of the path', 'grp', '/alpha grp'],
    ['a full subcommand path', 'alpha grp x', '/alpha grp'],
    ['a different case and a leading slash', '/FUN', '/fun'],
    ['full-width letters', 'ｆｕｎ', '/fun'],
    ['a Japanese description', '楽しむ', '/fun'],
    ['an English description', 'first', '/alpha one'],
  ])('finds the single best match by %s', async (_label, query, title) => {
    const { reply } = await runHelp({ commandOption: query });

    expect(embedAt(reply).title).toBe(title);
  });

  it('lists equally good matches instead of guessing between them', async () => {
    const { reply } = await runHelp({ commandOption: 'alpha' });

    expect(payloadAt(reply).flags).toBe(EPHEMERAL);
    expect(embedAt(reply)).toMatchObject({
      title: t('help.matchesTitle', 'en', { query: 'alpha' }),
      description: [
        line('alpha one', 'First thing'),
        line('alpha grp', 'Grouped things'),
        '',
        t('help.matchesHint', 'en'),
      ].join('\n'),
      color: COLORS.PRIMARY,
    });
  });

  describe('when only weak matches are found', () => {
    // `/notify voice` names 録音 only in a note saying it is not about it;
    // `/rec` is about 録音, but only its top-level description says so.
    const notify = helpCommand(
      new SlashCommandBuilder()
        .setName('notify')
        .setDescription('n')
        .addSubcommand((sub) =>
          sub
            .setName('voice')
            .setDescription('Join notices (not recording)')
            .setDescriptionLocalizations({ ja: 'VC通知（録音ではありません）' })
        ),
      { category: GENERAL }
    );
    const rec = helpCommand(
      new SlashCommandBuilder()
        .setName('rec')
        .setDescription('Recording tools')
        .setDescriptionLocalizations({ ja: '録音の道具' })
        .addSubcommand((sub) =>
          sub
            .setName('save')
            .setDescription('Save the audio')
            .setDescriptionLocalizations({ ja: '音声を保存' })
        )
        .addSubcommand((sub) =>
          sub
            .setName('list')
            .setDescription('Saved files')
            .setDescriptionLocalizations({ ja: '保存したファイル' })
        ),
      { category: GENERAL }
    );

    it('lists every match, best first, instead of opening a note’s command', async () => {
      resolveLocale.mockReturnValue('ja');

      const { reply } = await runHelp({
        commands: [notify, rec],
        commandOption: '録音',
      });

      expect(payloadAt(reply).flags).toBe(EPHEMERAL);
      expect(embedAt(reply)).toMatchObject({
        title: t('help.matchesTitle', 'ja', { query: '録音' }),
        description: [
          line('rec save', '音声を保存', [], 'ja'),
          line('rec list', '保存したファイル', [], 'ja'),
          line('notify voice', 'VC通知（録音ではありません）', [], 'ja'),
          '',
          t('help.matchesHint', 'ja'),
        ].join('\n'),
      });
    });

    it('lists even a single weak match rather than opening it', async () => {
      const { reply } = await runHelp({
        commands: [notify],
        commandOption: 'recording',
      });

      expect(embedAt(reply)).toMatchObject({
        title: t('help.matchesTitle', 'en', { query: 'recording' }),
        description: [
          line('notify voice', 'Join notices (not recording)'),
          '',
          t('help.matchesHint', 'en'),
        ].join('\n'),
      });
    });

    it('opens the entry whose own description matches over the others', async () => {
      const { reply } = await runHelp({
        commands: [notify, rec],
        commandOption: 'audio',
      });

      expect(embedAt(reply).title).toBe('/rec save');
    });

    it('opens the entry a declared keyword points at', async () => {
      const tagged = helpCommand(rec.data, {
        category: GENERAL,
        keywords: { 'rec save': [{ ja: '録音', en: 'recording' }] },
      });

      const { reply } = await runHelp({
        commands: [notify, tagged],
        commandOption: 'recording',
      });

      expect(embedAt(reply).title).toBe('/rec save');
    });
  });

  it('prefers a match on the path over one on a description', async () => {
    const atlas = helpCommand(
      new SlashCommandBuilder().setName('atlas').setDescription('Maps'),
      { category: GENERAL }
    );
    const notes = helpCommand(
      new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Keep an atlas of notes'),
      { category: GENERAL }
    );

    const { reply } = await runHelp({
      commands: [notes, atlas],
      commandOption: 'atlas',
    });

    expect(embedAt(reply).title).toBe('/atlas');
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

  it.each([
    ['a later word of the path', 'one', ['alpha one']],
    ['a subcommand below a group', 'x', ['alpha grp']],
    ['text inside the path', 'un', ['fun']],
    ['a Japanese description', '一つ', ['alpha one']],
    ['an English description', 'grouped', ['alpha grp']],
    ['the category name', 'community', ['fun']],
  ])('finds entries by %s', async (_label, focused, expected) => {
    const choices = await suggest({ focused });

    expect(choices.map((c) => c.value)).toEqual(expected);
  });

  it('ranks path, then word, then inner text, then description matches', async () => {
    const make = (
      name: string,
      description: string,
      sub?: { name: string; description: string }
    ) =>
      helpCommand(
        sub
          ? new SlashCommandBuilder()
              .setName(name)
              .setDescription('d')
              .addSubcommand((s) =>
                s.setName(sub.name).setDescription(sub.description)
              )
          : new SlashCommandBuilder().setName(name).setDescription(description),
        { category: GENERAL }
      );

    const choices = await suggest({
      // Loaded in the reverse of the expected order.
      commands: [
        make('misc', 'd', { name: 'notes', description: 'Keep a record' }),
        make('tools', 'd', { name: 'prerec', description: 'Warm up' }),
        make('voice', 'd', { name: 'record', description: 'Save audio' }),
        make('recap', 'Summaries'),
        make('other', 'Nothing here'),
      ],
      focused: 'rec',
    });

    expect(choices.map((c) => c.value)).toEqual([
      'recap',
      'voice record',
      'tools prerec',
      'misc notes',
    ]);
  });

  it('never suggests a hidden entry, even one whose description matches', async () => {
    expect(await suggest({ focused: 'owner' })).toEqual([]);
    expect(
      (await suggest({ focused: 'owner', userId: OWNER_ID })).map(
        (c) => c.value
      )
    ).toEqual(['secret']);
  });

  it('hides guild-permission entries when the member object is missing', async () => {
    const choices = await suggest({ focused: '', permissions: null });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
    ]);
  });

  it('offers guild-permission entries to a member holding the permission', async () => {
    const choices = await suggest({
      focused: '',
      permissions: PermissionFlagsBits.ManageGuild,
    });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
      'mod',
      'roles',
    ]);
  });

  it('offers a bot owner in DMs the owner entries but no guild-permission ones', async () => {
    const choices = await suggest({
      focused: '',
      userId: OWNER_ID,
      inGuild: false,
    });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
      'secret',
    ]);
  });

  it('ignores guild permissions on a member outside a guild', async () => {
    const choices = await suggest({
      focused: '',
      inGuild: false,
      rawMember: { permissions: new PermissionsBitField(MANAGE_BOTH) },
    });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
    ]);
  });

  it('does not trust raw API permission strings in suggestions', async () => {
    const choices = await suggest({
      focused: '',
      rawMember: { permissions: String(MANAGE_BOTH) },
    });

    expect(choices.map((c) => c.value)).toEqual([
      'alpha one',
      'alpha grp',
      'fun',
    ]);
  });

  // Regression: only the description used to be capped, so with the longest
  // names Discord allows (32 + 32 characters) a choice name reached 130
  // characters and Discord rejected the whole respond().
  it('keeps the whole suggestion label within 100 characters', async () => {
    const commandName = 'c'.repeat(32);
    const subcommandName = 's'.repeat(32);
    const longest = helpCommand(
      new SlashCommandBuilder()
        .setName(commandName)
        .setDescription('d')
        .addSubcommand((sub) =>
          sub.setName(subcommandName).setDescription('D'.repeat(100))
        ),
      { category: GENERAL }
    );

    const choices = await suggest({ commands: [longest], focused: 'c' });

    const entryName = `${commandName} ${subcommandName}`;
    // The value is never shortened: it is what help looks up.
    expect(choices).toEqual([
      { name: `${entryName} - ${'D'.repeat(31)}…`, value: entryName },
    ]);
    expect(choices[0].name).toHaveLength(100);
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
      { name: `wordy long - ${'L'.repeat(59)}…`, value: 'wordy long' },
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

describe('the help catalog cache', () => {
  /** Fresh fixtures whose serialization can be counted. */
  function countedCommands() {
    const commands = [
      helpCommand(
        new SlashCommandBuilder()
          .setName('alpha')
          .setDescription('a')
          .addSubcommand((sub) => sub.setName('one').setDescription('First')),
        { category: GENERAL }
      ),
      helpCommand(
        new SlashCommandBuilder().setName('mod').setDescription('Moderate'),
        { category: ADMIN, permission: 'manageGuild' }
      ),
    ];
    const spies = commands.map((command) => vi.spyOn(command.data, 'toJSON'));
    return { commands, spies };
  }

  /** Make every later interaction share the first one's loaded commands. */
  function sharing<T extends { interaction: unknown }>(
    first: { interaction: unknown },
    stub: T
  ): T {
    (stub.interaction as { client: { commands: unknown } }).client.commands = (
      first.interaction as { client: { commands: unknown } }
    ).client.commands;
    return stub;
  }

  it('serializes each command once per loaded command set', async () => {
    const { commands, spies } = countedCommands();
    const first = autocompleteInteraction({ commands, focused: '' });

    await autocompleteHelpCommand(first.interaction);
    for (const focused of ['a', 'mo', 'zzz']) {
      const stub = sharing(
        first,
        autocompleteInteraction({
          commands,
          focused,
          permissions: PermissionFlagsBits.ManageGuild,
        })
      );
      await autocompleteHelpCommand(stub.interaction);
    }
    const run = sharing(first, chatInteraction({ commands }));
    await executeHelpCommand(run.interaction);
    const detail = sharing(
      first,
      chatInteraction({ commands, commandOption: 'alpha one' })
    );
    await executeHelpCommand(detail.interaction);

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still decides visibility per asker', async () => {
    const { commands } = countedCommands();
    const member = autocompleteInteraction({ commands, focused: '' });
    await autocompleteHelpCommand(member.interaction);
    const manager = sharing(
      member,
      autocompleteInteraction({
        commands,
        focused: '',
        permissions: PermissionFlagsBits.ManageGuild,
      })
    );
    await autocompleteHelpCommand(manager.interaction);

    expect(member.respond.mock.calls[0][0]).toEqual([
      { name: 'alpha one - First', value: 'alpha one' },
    ]);
    expect(manager.respond.mock.calls[0][0]).toEqual([
      { name: 'alpha one - First', value: 'alpha one' },
      { name: 'mod - Moderate', value: 'mod' },
    ]);
  });

  it('picks up a replaced command collection', async () => {
    const { commands, spies } = countedCommands();
    const before = autocompleteInteraction({ commands, focused: '' });
    await autocompleteHelpCommand(before.interaction);

    // The loader assigns a new collection on reload.
    const after = autocompleteInteraction({ commands, focused: '' });
    await autocompleteHelpCommand(after.interaction);

    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(2);
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

  /** Ids as long as Discord's, so length checks see real mentions. */
  function registerAllIds() {
    setCommandIds(
      commands.map((command, index) => ({
        name: command.data.name,
        id: String(1_300_000_000_000_000_000n + BigInt(index)),
      }))
    );
  }

  beforeAll(async () => {
    // Start clean whatever ran before (e.g. the config warning logged when
    // this file loads), so the check below sees only discovery.
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();

    const discovered = await discoverFeatureCommands(FEATURES_PATH);

    // A command module that fails to import, or exports no valid command,
    // would silently drop out of help. Other import-time logging from the
    // features is not this suite's concern.
    const registryProblems = [
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ].filter(([message]) =>
      /Failed to load command|Invalid command file/.test(String(message))
    );
    expect(registryProblems).toEqual([]);

    commands = discovered.map((item) => item.command);
    catalog = buildHelpCatalog(commands);
    entries = catalog.flatMap((category) => category.commands);
  });

  it('lists the general command itself', () => {
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['general help', 'general ping', 'general about'])
    );
  });

  it.each<[Locale, boolean]>([
    ['en', false],
    ['ja', false],
    ['en', true],
    ['ja', true],
  ])(
    'renders a detail page for every catalog entry within Discord limits (%s, ids known: %s)',
    async (locale, withIds) => {
      resolveLocale.mockReturnValue(locale);
      if (withIds) registerAllIds();
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
        expect(embed.description, entry.name).toMatch(
          new RegExp(
            `^${entry.description[locale].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
          )
        );
        expect(embedTextLength(embed), entry.name).toBeLessThanOrEqual(6000);

        const leaves = entry.leaves ?? [];
        expect(leaves.length, entry.name).toBeGreaterThan(0);
        const usageFields = (embed.fields ?? []).filter(
          (f) => f.name !== t('help.examples', locale)
        );
        expect(usageFields, entry.name).toHaveLength(leaves.length);
        for (const [index, leaf] of leaves.entries()) {
          const value = usageFields[index].value;
          expect(value.length, leaf.path).toBeLessThanOrEqual(1024);
          const reference = withIds
            ? new RegExp(`^</${leaf.path}:\\d+>`)
            : new RegExp(`^\`/${leaf.path}\``);
          expect(value, leaf.path).toMatch(reference);
          // Every option is described.
          expect(value.split('\n'), leaf.path).toHaveLength(
            1 + leaf.options.length
          );
        }
      }
    }
  );

  it.each<[Locale, boolean]>([
    ['en', false],
    ['ja', false],
    ['en', true],
    ['ja', true],
  ])(
    'fits the full overview into one embed Discord accepts (%s, ids known: %s)',
    async (locale, withIds) => {
      resolveLocale.mockReturnValue(locale);
      if (withIds) registerAllIds();

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
        // Nothing was cut off by the per-field limit.
        expect(value.split('\n'), category.name.en).toHaveLength(
          category.commands.length
        );
        expect(value).not.toContain('…\n');
      }
      expect(selectMenuAt(reply).options).toHaveLength(catalog.length + 1);
    }
  );

  it('offers every entry in the command menu to an owner who manages the server', async () => {
    const { reply } = await openPanel({
      commands,
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
    });

    const menu = componentAt<APIStringSelectComponent>(reply, 'help_command');
    expect(menu?.options.map((o) => o.value)).toEqual(
      entries.map((e) => e.name)
    );
    for (const option of menu?.options ?? []) {
      expect(option.label.length).toBeLessThanOrEqual(100);
      expect((option.description ?? '').length).toBeLessThanOrEqual(100);
    }
  });

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
    expect(JSON.stringify(componentsAt(reply))).not.toContain('owner ');

    const suggestions = autocompleteInteraction({
      commands,
      userId: USER_ID,
      permissions: MANAGE_BOTH,
      focused: 'owner',
    });
    await autocompleteHelpCommand(suggestions.interaction);
    const values = (
      suggestions.respond.mock.calls[0][0] as Array<{ value: string }>
    ).map((choice) => choice.value);
    expect(values.filter((value) => value.startsWith('owner'))).toEqual([]);
  });

  it.each([
    ['record', 'voice record'],
    ['poll', 'community poll'],
    ['exclude', 'voice autojoin'],
  ])('suggests the entry for "%s" first', async (focused, expected) => {
    const stub = autocompleteInteraction({
      commands,
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
      focused,
    });
    await autocompleteHelpCommand(stub.interaction);

    const choices = stub.respond.mock.calls[0][0] as Array<{
      value: string;
    }>;
    expect(choices[0]?.value).toBe(expected);
  });

  it('finds commands by their Japanese descriptions', async () => {
    resolveLocale.mockReturnValue('ja');
    const stub = autocompleteInteraction({
      commands,
      userId: OWNER_ID,
      permissions: MANAGE_BOTH,
      focused: '投票',
    });
    await autocompleteHelpCommand(stub.interaction);

    const values = (
      stub.respond.mock.calls[0][0] as Array<{ value: string }>
    ).map((choice) => choice.value);
    expect(values).toContain('community poll');
  });

  /** What help answers `query` with, as the given asker. */
  async function answer(query: string, asker: ChatInteractionOptions = {}) {
    const { reply } = await runHelp({
      commands,
      commandOption: query,
      ...asker,
    });
    return embedAt(reply);
  }

  const ADMIN_ASKER = { userId: OWNER_ID, permissions: MANAGE_BOTH };

  it('opens /voice record for 録音 as an admin, not the notice settings', async () => {
    resolveLocale.mockReturnValue('ja');

    const embed = await answer('録音', ADMIN_ASKER);

    // `/voice record` declares 録音 as a search word, so it is the one
    // decisive match; the notification entry only says it is not recording.
    expect(embed.title).toBe('/voice record');
  });

  it('lists nothing about recording to a member who cannot record', async () => {
    resolveLocale.mockReturnValue('ja');

    const embed = await answer('録音');

    expect(JSON.stringify(embed)).not.toContain('/voice record');
  });

  it('suggests the voice commands first for 録音', async () => {
    resolveLocale.mockReturnValue('ja');
    const stub = autocompleteInteraction({
      commands,
      ...ADMIN_ASKER,
      focused: '録音',
    });
    await autocompleteHelpCommand(stub.interaction);

    const values = (
      stub.respond.mock.calls[0][0] as Array<{ value: string }>
    ).map((choice) => choice.value);
    expect(values[0]).toBe('voice record');
    expect(values.indexOf('notification voice')).not.toBe(0);
  });

  it.each<[string, ChatInteractionOptions]>([
    ['a member', {}],
    ['an admin', ADMIN_ASKER],
  ])('finds the roulette for ルーレット as %s', async (_label, asker) => {
    resolveLocale.mockReturnValue('ja');

    const embed = await answer('ルーレット', asker);

    expect(embed.title).not.toBe(t('help.commandNotFound', 'ja'));
    expect(JSON.stringify(embed)).toContain('/community roulette');
  });

  /** The search words the `command` option's description offers as examples. */
  function advertisedTerms(): Array<[Locale, string]> {
    const general = commands.find((c) => c.data.name === 'general');
    const json = general?.data.toJSON() as {
      options: Array<{
        name: string;
        options?: Array<{
          name: string;
          description: string;
          description_localizations?: { ja?: string };
        }>;
      }>;
    };
    const option = json.options
      .find((sub) => sub.name === 'help')
      ?.options?.find((o) => o.name === 'command');
    const ja = /例: (.+)）/.exec(option?.description_localizations?.ja ?? '');
    const en = /e\.g\. (.+)$/.exec(option?.description ?? '');

    return [
      ...(ja?.[1].split('、') ?? []).map(
        (term) => ['ja', term] as [Locale, string]
      ),
      ...(en?.[1].split(' or ') ?? []).map(
        (term) => ['en', term] as [Locale, string]
      ),
    ];
  }

  it('finds something for every search word the command option suggests, as a member', async () => {
    const terms = advertisedTerms();
    expect(terms.length).toBeGreaterThanOrEqual(4);

    for (const [locale, term] of terms) {
      resolveLocale.mockReturnValue(locale);
      const embed = await answer(term);
      expect(embed.title, term).not.toBe(t('help.commandNotFound', locale));
    }
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
