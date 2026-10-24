import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  Locale,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * What the bot sends Discord when it registers its slash commands.
 *
 * Discord validates the payload only at deploy time, and rejects the whole
 * bulk overwrite when a single command breaks a rule - so a bad description
 * length or a misordered required option takes every command down with it.
 * These checks walk the real registry's output against Discord's documented
 * limits (Application Commands -> Registering a Command), so a command added
 * under `src/features/<f>/commands/` is covered without touching this file.
 *
 * The help catalog is built from the same JSON, so its consistency with the
 * commands (and the translations that point users at commands) lives here
 * too.
 */

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../shared/utils/logger.js', () => ({
  logger,
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

import {
  buildCommandCollection,
  toDeploymentPayload,
} from '../../../app/interactions/commandRegistry.js';
import {
  buildHelpCatalog,
  type CommandInfo,
  type PermissionLevel,
} from '../../../shared/help/catalog.js';
import type { Command } from '../../../shared/types/index.js';
import { en } from '../../../locales/en.js';
import { ja } from '../../../locales/ja.js';
import {
  commandPaths,
  featuresWithCommandFiles,
  invalidSlashReferences,
  leafKeys,
  loadCommands,
  pathPrefixes,
  type CommandJSON,
  type Localizations,
  type LooseOption,
} from './command-smoke.helpers.js';

const commands = await loadCommands();
/**
 * What discovery logged. Config warnings are left out: importing the backup
 * service reads (and validates) the environment eagerly - see the bug noted
 * in the test report - and under Vitest `NODE_ENV=test` always warns.
 */
const discoveryWarnings = logger.warn.mock.calls.filter(
  ([message]) => !String(message).startsWith('Config: ')
);
const discoveryErrors = [...logger.error.mock.calls];

const COMMAND_CASES = commands.map(
  (entry) => [`/${entry.json.name}`, entry] as const
);

// Discord's documented limits.
const NAME_PATTERN = /^[-_\p{L}\p{N}]{1,32}$/u;
const MAX_DESCRIPTION = 100;
const MAX_OPTIONS = 25;
const MAX_CHOICES = 25;
const MAX_CHOICE_NAME = 100;
const MAX_CHOICE_STRING_VALUE = 100;
const MAX_STRING_LENGTH = 6000;
const MAX_GLOBAL_CHAT_COMMANDS = 100;
/**
 * Combined length of every name, description and choice value in one
 * command (options, subcommands and groups included), per locale.
 */
const MAX_COMMAND_CHARACTERS = 8000;

const DISCORD_LOCALES = new Set<string>(Object.values(Locale));
const CHANNEL_TYPES = new Set<number>(
  Object.values(ChannelType).filter((v): v is number => typeof v === 'number')
);
const CONTEXTS = new Set<number>(
  Object.values(InteractionContextType).filter(
    (v): v is number => typeof v === 'number'
  )
);
const INTEGRATION_TYPES = new Set<number>(
  Object.values(ApplicationIntegrationType).filter(
    (v): v is number => typeof v === 'number'
  )
);
const NESTING = new Set<ApplicationCommandOptionType>([
  ApplicationCommandOptionType.Subcommand,
  ApplicationCommandOptionType.SubcommandGroup,
]);
const CHOICE_TYPES = new Set<ApplicationCommandOptionType>([
  ApplicationCommandOptionType.String,
  ApplicationCommandOptionType.Integer,
  ApplicationCommandOptionType.Number,
]);
const NUMERIC_TYPES = new Set<ApplicationCommandOptionType>([
  ApplicationCommandOptionType.Integer,
  ApplicationCommandOptionType.Number,
]);

// ---------------------------------------------------------------------------
// Rule checks. Each returns human-readable problems, so a failure names the
// exact field and rule rather than just "expected false to be true".
// ---------------------------------------------------------------------------

function nameProblems(where: string, name: string): string[] {
  const problems: string[] = [];
  if (!NAME_PATTERN.test(name)) {
    problems.push(`${where}: name "${name}" must match ${NAME_PATTERN}`);
  }
  if (name !== name.toLowerCase()) {
    problems.push(`${where}: name "${name}" must be lowercase`);
  }
  return problems;
}

function lengthProblems(
  where: string,
  label: string,
  text: string,
  max: number
): string[] {
  return text.length >= 1 && text.length <= max
    ? []
    : [`${where}: ${label} is ${text.length} chars (1-${max})`];
}

function localizationProblems(
  where: string,
  kind: 'name' | 'description' | 'choice name',
  localizations: Localizations | undefined
): string[] {
  const problems: string[] = [];
  for (const [locale, value] of Object.entries(localizations ?? {})) {
    if (!DISCORD_LOCALES.has(locale)) {
      problems.push(`${where}: "${locale}" is not a Discord locale`);
    }
    if (value === null || value === undefined) continue;
    const at = `${where} [${locale}]`;
    if (kind === 'name') problems.push(...nameProblems(at, value));
    else {
      problems.push(
        ...lengthProblems(
          at,
          kind,
          value,
          kind === 'description' ? MAX_DESCRIPTION : MAX_CHOICE_NAME
        )
      );
    }
  }
  return problems;
}

function duplicates(values: readonly unknown[]): unknown[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function choiceProblems(where: string, option: LooseOption): string[] {
  const choices = option.choices ?? [];
  if (choices.length === 0) return [];

  const problems: string[] = [];
  if (!CHOICE_TYPES.has(option.type)) {
    problems.push(`${where}: only string/integer/number options take choices`);
  }
  if (choices.length > MAX_CHOICES) {
    problems.push(`${where}: ${choices.length} choices (max ${MAX_CHOICES})`);
  }
  for (const value of duplicates(choices.map((choice) => choice.name))) {
    problems.push(`${where}: duplicate choice name "${String(value)}"`);
  }
  for (const value of duplicates(choices.map((choice) => choice.value))) {
    problems.push(`${where}: duplicate choice value "${String(value)}"`);
  }

  for (const choice of choices) {
    const at = `${where} choice "${choice.name}"`;
    problems.push(
      ...lengthProblems(at, 'name', choice.name, MAX_CHOICE_NAME),
      ...localizationProblems(at, 'choice name', choice.name_localizations)
    );

    if (option.type === ApplicationCommandOptionType.String) {
      if (typeof choice.value !== 'string') {
        problems.push(`${at}: value must be a string`);
      } else {
        problems.push(
          ...lengthProblems(at, 'value', choice.value, MAX_CHOICE_STRING_VALUE)
        );
      }
      continue;
    }

    if (typeof choice.value !== 'number' || !Number.isFinite(choice.value)) {
      problems.push(`${at}: value must be a number`);
      continue;
    }
    if (
      option.type === ApplicationCommandOptionType.Integer &&
      !Number.isSafeInteger(choice.value)
    ) {
      problems.push(`${at}: value must be a safe integer`);
    }
    if (option.min_value !== undefined && choice.value < option.min_value) {
      problems.push(`${at}: value is below min_value ${option.min_value}`);
    }
    if (option.max_value !== undefined && choice.value > option.max_value) {
      problems.push(`${at}: value is above max_value ${option.max_value}`);
    }
  }
  return problems;
}

/** Rules for a leaf (non-subcommand) option's own fields. */
function basicOptionProblems(where: string, option: LooseOption): string[] {
  const problems = choiceProblems(where, option);
  const isString = option.type === ApplicationCommandOptionType.String;
  const isNumeric = NUMERIC_TYPES.has(option.type);

  if (option.autocomplete) {
    if (!CHOICE_TYPES.has(option.type)) {
      problems.push(
        `${where}: only string/integer/number options autocomplete`
      );
    }
    if ((option.choices ?? []).length > 0) {
      problems.push(`${where}: autocomplete cannot be combined with choices`);
    }
  }

  if (option.channel_types !== undefined) {
    if (option.type !== ApplicationCommandOptionType.Channel) {
      problems.push(`${where}: channel_types on a non-channel option`);
    }
    for (const type of option.channel_types) {
      if (!CHANNEL_TYPES.has(type)) {
        problems.push(`${where}: unknown channel type ${type}`);
      }
    }
  }

  const { min_length: minLength, max_length: maxLength } = option;
  if (minLength !== undefined || maxLength !== undefined) {
    if (!isString) problems.push(`${where}: length bounds on a non-string`);
    if (
      minLength !== undefined &&
      (minLength < 0 || minLength > MAX_STRING_LENGTH)
    ) {
      problems.push(
        `${where}: min_length ${minLength} (0-${MAX_STRING_LENGTH})`
      );
    }
    if (
      maxLength !== undefined &&
      (maxLength < 1 || maxLength > MAX_STRING_LENGTH)
    ) {
      problems.push(
        `${where}: max_length ${maxLength} (1-${MAX_STRING_LENGTH})`
      );
    }
    if (
      minLength !== undefined &&
      maxLength !== undefined &&
      minLength > maxLength
    ) {
      problems.push(
        `${where}: min_length ${minLength} > max_length ${maxLength}`
      );
    }
  }

  const { min_value: minValue, max_value: maxValue } = option;
  if (minValue !== undefined || maxValue !== undefined) {
    if (!isNumeric) problems.push(`${where}: value bounds on a non-number`);
    if (
      minValue !== undefined &&
      maxValue !== undefined &&
      minValue > maxValue
    ) {
      problems.push(`${where}: min_value ${minValue} > max_value ${maxValue}`);
    }
  }

  if (option.options !== undefined && option.options.length > 0) {
    problems.push(`${where}: a ${option.type} option cannot have sub-options`);
  }
  return problems;
}

type Level = 'command' | 'group' | 'subcommand';

/**
 * One level of options: count, unique names, nesting rules and required
 * ordering, then each option's own fields, recursing into subcommands.
 */
function optionListProblems(
  where: string,
  options: readonly LooseOption[],
  level: Level
): string[] {
  const problems: string[] = [];

  if (options.length > MAX_OPTIONS) {
    problems.push(`${where}: ${options.length} options (max ${MAX_OPTIONS})`);
  }
  for (const name of duplicates(options.map((option) => option.name))) {
    problems.push(`${where}: duplicate option name "${String(name)}"`);
  }

  const nested = options.filter((option) => NESTING.has(option.type));
  if (
    level === 'command' &&
    nested.length > 0 &&
    nested.length < options.length
  ) {
    problems.push(`${where}: subcommands cannot be mixed with plain options`);
  }
  if (level === 'group') {
    for (const option of options) {
      if (option.type !== ApplicationCommandOptionType.Subcommand) {
        problems.push(
          `${where} ${option.name}: a group may only hold subcommands`
        );
      }
    }
  }
  if (level === 'subcommand' && nested.length > 0) {
    problems.push(`${where}: a subcommand cannot nest subcommands or groups`);
  }

  const firstOptional = options.findIndex(
    (option) => !NESTING.has(option.type) && !option.required
  );
  if (firstOptional !== -1) {
    for (const option of options.slice(firstOptional + 1)) {
      if (option.required) {
        problems.push(
          `${where} ${option.name}: required options must come before optional ones`
        );
      }
    }
  }

  for (const option of options) {
    const at = `${where} ${option.name}`;
    problems.push(
      ...nameProblems(at, option.name),
      ...localizationProblems(at, 'name', option.name_localizations),
      ...lengthProblems(at, 'description', option.description, MAX_DESCRIPTION),
      ...localizationProblems(
        at,
        'description',
        option.description_localizations
      )
    );

    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      if (option.required) problems.push(`${at}: a group cannot be required`);
      if ((option.options ?? []).length === 0) {
        problems.push(`${at}: an empty subcommand group`);
      }
      problems.push(...optionListProblems(at, option.options ?? [], 'group'));
    } else if (option.type === ApplicationCommandOptionType.Subcommand) {
      if (option.required)
        problems.push(`${at}: a subcommand cannot be required`);
      problems.push(
        ...optionListProblems(at, option.options ?? [], 'subcommand')
      );
    } else {
      problems.push(...basicOptionProblems(at, option));
    }
  }

  return problems;
}

function pick(
  base: string,
  localizations: Localizations | undefined,
  locale?: string
) {
  return (locale && localizations?.[locale]) || base;
}

/** Discord's combined-length measure for one command in one locale. */
function combinedLength(json: CommandJSON, locale?: string): number {
  const measureOptions = (options: readonly LooseOption[]): number =>
    options.reduce(
      (sum, option) =>
        sum +
        pick(option.name, option.name_localizations, locale).length +
        pick(option.description, option.description_localizations, locale)
          .length +
        (option.choices ?? []).reduce(
          (choices, choice) =>
            choices +
            pick(choice.name, choice.name_localizations, locale).length +
            String(choice.value).length,
          0
        ) +
        measureOptions(option.options ?? []),
      0
    );

  return (
    pick(json.name, json.name_localizations, locale).length +
    pick(json.description, json.description_localizations, locale).length +
    measureOptions(json.options ?? [])
  );
}

/** Every locale any part of a command is localized into. */
function localesUsed(json: CommandJSON): string[] {
  const locales = new Set<string>();
  const add = (localizations: Localizations | undefined) => {
    for (const locale of Object.keys(localizations ?? {})) locales.add(locale);
  };
  const walk = (options: readonly LooseOption[]) => {
    for (const option of options) {
      add(option.name_localizations);
      add(option.description_localizations);
      for (const choice of option.choices ?? []) add(choice.name_localizations);
      walk(option.options ?? []);
    }
  };
  add(json.name_localizations);
  add(json.description_localizations);
  walk(json.options ?? []);
  return [...locales];
}

function topLevelProblems(json: CommandJSON): string[] {
  const where = `/${json.name}`;
  const problems = [
    ...nameProblems(where, json.name),
    ...localizationProblems(where, 'name', json.name_localizations),
    ...lengthProblems(where, 'description', json.description, MAX_DESCRIPTION),
    ...localizationProblems(
      where,
      'description',
      json.description_localizations
    ),
    ...optionListProblems(where, json.options ?? [], 'command'),
  ];

  if (json.type !== undefined && json.type !== 1) {
    problems.push(`${where}: type ${json.type} is not CHAT_INPUT (1)`);
  }

  const permissions = json.default_member_permissions;
  if (permissions !== undefined && permissions !== null) {
    if (!/^\d+$/.test(permissions)) {
      problems.push(
        `${where}: default_member_permissions "${permissions}" is not a bitfield string`
      );
    } else if ((BigInt(permissions) & ~PermissionsBitField.All) !== 0n) {
      problems.push(`${where}: default_member_permissions has unknown bits`);
    }
  }

  for (const context of json.contexts ?? []) {
    if (!CONTEXTS.has(context))
      problems.push(`${where}: unknown context ${context}`);
  }
  if (json.contexts && json.contexts.length === 0) {
    problems.push(
      `${where}: an empty contexts list makes the command unusable`
    );
  }
  for (const type of json.integration_types ?? []) {
    if (!INTEGRATION_TYPES.has(type)) {
      problems.push(`${where}: unknown integration type ${type}`);
    }
  }

  for (const locale of [undefined, ...localesUsed(json)]) {
    const length = combinedLength(json, locale);
    if (length > MAX_COMMAND_CHARACTERS) {
      problems.push(
        `${where}: ${length} combined characters${locale ? ` in ${locale}` : ''} (max ${MAX_COMMAND_CHARACTERS})`
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------

describe('command discovery', () => {
  it('loads every command file without a warning or error', () => {
    expect(discoveryWarnings).toEqual([]);
    expect(discoveryErrors).toEqual([]);
    expect([...new Set(commands.map((entry) => entry.feature))].sort()).toEqual(
      featuresWithCommandFiles()
    );
  });

  it('gives every command a unique name, within the global command limit', () => {
    const names = commands.map((entry) => entry.json.name);

    expect(duplicates(names)).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThanOrEqual(MAX_GLOBAL_CHAT_COMMANDS);
  });

  it('deploys exactly the JSON each command builds', () => {
    const payload = toDeploymentPayload(buildCommandCollection(commands));

    expect(payload).toEqual(
      commands.map((entry) => entry.command.data.toJSON())
    );
    // The payload must survive the JSON round trip the REST client does.
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe('each command satisfies Discord registration rules', () => {
  it.each(COMMAND_CASES)('%s', (_title, entry) => {
    expect(topLevelProblems(entry.json)).toEqual([]);
  });
});

describe('the rule checks themselves', () => {
  const base = (options: LooseOption[] = []): CommandJSON => ({
    name: 'probe',
    description: 'Probe',
    options,
  });
  const text = (
    name: string,
    extra: Partial<LooseOption> = {}
  ): LooseOption => ({
    type: ApplicationCommandOptionType.String,
    name,
    description: name,
    ...extra,
  });

  it('accepts a well-formed command', () => {
    expect(
      topLevelProblems({
        ...base([
          text('needed', { required: true, min_length: 1, max_length: 10 }),
          text('extra', { choices: [{ name: 'A', value: 'a' }] }),
        ]),
        name_localizations: { ja: 'プローブ' },
        default_member_permissions: String(PermissionFlagsBits.ManageGuild),
        contexts: [0, 1],
      })
    ).toEqual([]);
  });

  it.each<[string, CommandJSON, RegExp]>([
    ['an uppercase name', { ...base(), name: 'Probe' }, /must be lowercase/],
    ['a name with a space', { ...base(), name: 'pro be' }, /must match/],
    ['a 33-char name', { ...base(), name: 'p'.repeat(33) }, /must match/],
    [
      'an empty description',
      { ...base(), description: '' },
      /description is 0 chars/,
    ],
    [
      'a 101-char description',
      { ...base(), description: 'd'.repeat(101) },
      /description is 101 chars/,
    ],
    [
      'an unknown locale',
      { ...base(), description_localizations: { xx: 'x' } },
      /not a Discord locale/,
    ],
    [
      'a long localized description',
      { ...base(), description_localizations: { ja: 'あ'.repeat(101) } },
      /\[ja\]: description is 101/,
    ],
    [
      '26 options',
      base(Array.from({ length: 26 }, (_, i) => text(`o${i}`))),
      /26 options/,
    ],
    [
      'required after optional',
      base([text('a'), text('b', { required: true })]),
      /required options must come before/,
    ],
    [
      'duplicate option names',
      base([text('a'), text('a')]),
      /duplicate option name/,
    ],
    [
      '26 choices',
      base([
        text('a', {
          choices: Array.from({ length: 26 }, (_, i) => ({
            name: `c${i}`,
            value: `${i}`,
          })),
        }),
      ]),
      /26 choices/,
    ],
    [
      'a 101-char choice value',
      base([text('a', { choices: [{ name: 'c', value: 'v'.repeat(101) }] })]),
      /value is 101 chars/,
    ],
    [
      'autocomplete with choices',
      base([
        text('a', { autocomplete: true, choices: [{ name: 'c', value: 'c' }] }),
      ]),
      /cannot be combined/,
    ],
    [
      'min_length above max_length',
      base([text('a', { min_length: 5, max_length: 2 })]),
      /min_length 5 > max_length 2/,
    ],
    [
      'max_length above 6000',
      base([text('a', { max_length: 6001 })]),
      /max_length 6001/,
    ],
    [
      'subcommands mixed with options',
      base([
        text('a'),
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 's',
          description: 's',
        },
      ]),
      /cannot be mixed/,
    ],
    [
      'a plain option inside a group',
      base([
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: 'g',
          description: 'g',
          options: [text('a')],
        },
      ]),
      /may only hold subcommands/,
    ],
    [
      'an over-long command',
      base(
        Array.from({ length: 25 }, (_, i) =>
          text(`o${i}`, {
            description: 'd'.repeat(100),
            choices: Array.from({ length: 25 }, (_, j) => ({
              name: 'n'.repeat(100),
              value: `${j}`,
            })),
          })
        )
      ),
      /combined characters/,
    ],
    ['an empty contexts list', { ...base(), contexts: [] }, /empty contexts/],
    [
      'a malformed permission bitfield',
      { ...base(), default_member_permissions: 'ManageGuild' },
      /not a bitfield string/,
    ],
  ])('rejects %s', (_label, json, problem) => {
    expect(topLevelProblems(json)).toContainEqual(
      expect.stringMatching(problem)
    );
  });
});

describe('the help catalog built from these commands', () => {
  const catalog = buildHelpCatalog(commands.map((entry) => entry.command));
  const entries = catalog.flatMap((category) => category.commands);
  const byName = new Map(entries.map((info) => [info.name, info]));
  const LEVELS = new Set<PermissionLevel>([
    'everyone',
    'manageGuild',
    'manageRoles',
    'owner',
  ]);
  const levels = (info: CommandInfo) =>
    [info.requiredPermission ?? 'everyone'].flat();

  it.each(COMMAND_CASES)(
    '%s is listed with one entry per subcommand or group',
    (_title, entry) => {
      const { help } = entry.command;
      expect(
        help,
        'commands without `help` are hidden from /general help'
      ).toBeDefined();
      expect(help!.category.en.trim()).not.toBe('');
      expect(help!.category.ja.trim()).not.toBe('');

      const top = entry.json.options ?? [];
      const expected = top.some((option) => NESTING.has(option.type))
        ? top.map((option) => `${entry.json.name} ${option.name}`)
        : [entry.json.name];
      const listed = entries
        .map((info) => info.name)
        .filter((name) => name.split(' ')[0] === entry.json.name);

      expect(listed).toEqual(expected);
      for (const name of expected) {
        const info = byName.get(name)!;
        expect(info.description.en.trim()).not.toBe('');
        expect(info.description.ja.trim()).not.toBe('');
        for (const level of levels(info)) expect(LEVELS).toContain(level);
      }

      for (const key of Object.keys(help!.subcommandPermissions ?? {})) {
        expect(expected, `stale subcommandPermissions key "${key}"`).toContain(
          key
        );
      }
    }
  );

  it('shows usage for exactly the runnable command paths', () => {
    const usage = entries
      .flatMap((info) => (info.usage ?? '').split(', '))
      .map((leaf) => leaf.replace(/^\//, ''))
      .sort();
    const runnable = commandPaths(commands)
      .map((path) => path.label)
      .sort();

    expect(usage).toEqual(runnable);
  });

  it('never advertises a Manage Server command to everyone', () => {
    const leaks = commands.flatMap((entry) => {
      const required = new PermissionsBitField();
      for (const permission of entry.command.options?.permissions ?? []) {
        required.add(permission);
      }
      if (entry.json.default_member_permissions) {
        required.add(BigInt(entry.json.default_member_permissions));
      }
      if (!required.has(PermissionFlagsBits.ManageGuild)) return [];

      return entries
        .filter((info) => info.name.split(' ')[0] === entry.json.name)
        .filter((info) => levels(info).includes('everyone'))
        .map((info) => info.name);
    });

    expect(leaks).toEqual([]);
  });

  it('uses one Japanese label per category', () => {
    const labels = new Map<string, Set<string>>();
    for (const { command } of commands) {
      if (!command.help) continue;
      const { en: english, ja: japanese } = command.help.category;
      labels.set(english, (labels.get(english) ?? new Set()).add(japanese));
    }
    const conflicting = [...labels].filter(([, ja]) => ja.size > 1);

    expect(conflicting).toEqual([]);
  });
});

describe('command shapes no current command uses yet', () => {
  // Every command today nests subcommands and leaves gating to `help` or
  // middleware. A future one may take plain options or rely on Discord's
  // default permissions instead; help and the rule checks must handle it.
  const echo: Command = {
    data: new SlashCommandBuilder()
      .setName('echo')
      .setDescription('Repeat some text')
      .setDescriptionLocalizations({ ja: 'テキストを繰り返す' })
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addStringOption((option) =>
        option
          .setName('text')
          .setDescription('Text to repeat')
          .setRequired(true)
          .setMaxLength(200)
      ),
    help: { category: { en: 'Utility', ja: 'ユーティリティ' } },
    execute: async () => undefined,
  };
  const hidden: Command = {
    data: new SlashCommandBuilder().setName('hidden').setDescription('Hidden'),
    execute: async () => undefined,
  };

  it('lists a command without subcommands as a single entry', () => {
    expect(buildHelpCatalog([echo, hidden])).toEqual([
      {
        name: { en: 'Utility', ja: 'ユーティリティ' },
        commands: [
          {
            name: 'echo',
            description: { en: 'Repeat some text', ja: 'テキストを繰り返す' },
            usage: '/echo',
            requiredPermission: 'manageRoles',
          },
        ],
      },
    ]);
  });

  it('accepts it under the registration rules and smoke-tests its path', () => {
    const json = echo.data.toJSON() as unknown as CommandJSON;

    expect(topLevelProblems(json)).toEqual([]);
    expect(
      commandPaths([
        { feature: 'utility', filePath: 'echo.ts', command: echo, json },
      ])
    ).toEqual([
      expect.objectContaining({
        label: 'echo',
        group: null,
        subcommand: null,
        options: [expect.objectContaining({ name: 'text', required: true })],
      }),
    ]);
  });
});

describe('translations that point users at a command', () => {
  /**
   * Known stale references, keyed by translation key. Production bug: the
   * recording command moved under `/voice record`, but the split-delivery
   * failure text still tells users to run `/record`. Remove the entry once
   * the text is fixed.
   */
  const KNOWN_STALE: Record<string, string[]> = {
    'record.errors.deliveryIncompleteDesc': ['/record'],
  };
  const known = pathPrefixes(commandPaths(commands));
  const valueAt = (dictionary: unknown, key: string): string =>
    String(
      key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          dictionary
        )
    );

  it.each([
    ['en', en],
    ['ja', ja],
  ] as const)('%s names only commands that exist', (_lang, dictionary) => {
    const stale = leafKeys(dictionary).flatMap((key) =>
      invalidSlashReferences(valueAt(dictionary, key), known)
        .filter((reference) => !KNOWN_STALE[key]?.includes(reference))
        .map((reference) => `${key}: ${reference}`)
    );

    expect(stale).toEqual([]);
  });
});
