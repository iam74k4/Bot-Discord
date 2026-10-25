import {
  PermissionsBitField,
  type APIApplicationCommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Command } from '../types/command.js';

export type PermissionLevel =
  | 'everyone'
  | 'manageGuild'
  | 'manageRoles'
  | 'administrator'
  | 'owner';

/** Help metadata a command declares alongside its definition. */
export interface CommandHelp {
  /** Localized category heading in `/general help`. */
  category: LocalizedText;
  /**
   * Who may see the command. Derived from the command's own permission
   * declarations when omitted; set it explicitly only where the requirement
   * is not expressed in the builder (owner-only commands).
   */
  permission?: PermissionLevel | PermissionLevel[];
  /**
   * Per-entry overrides keyed by the listed path, e.g. `'notification voice'`.
   * Only needed where a subcommand enforces a permission in code that the
   * builder cannot declare.
   */
  subcommandPermissions?: Record<string, PermissionLevel | PermissionLevel[]>;
  /**
   * Worked examples shown on an entry's detail page, keyed by the runnable
   * path they demonstrate (`'voice record'`, `'community poll create'`).
   * Write each as one line, e.g. `` '`/voice record duration:1分` 直前1分を保存' ``.
   */
  examples?: Record<string, LocalizedText[]>;
  /**
   * Extra search words keyed by the listed path, for terms people type that
   * the descriptions do not use, e.g.
   * `{ 'voice record': [{ ja: '録音', en: 'recording' }] }`. They rank like
   * the entry's own description in `/general help` search.
   */
  keywords?: Record<string, LocalizedText[]>;
}

export interface LocalizedText {
  en: string;
  ja: string;
}

/** One option of a runnable path, as the Discord client shows it. */
export interface HelpOption {
  /** Base name (`en`) and the name a Japanese client shows (`ja`). */
  name: LocalizedText;
  description: LocalizedText;
  required: boolean;
  /** Fixed choices, when the option has them. */
  choices?: LocalizedText[];
}

/** A path someone can actually run, such as `voice autojoin exclude`. */
export interface HelpLeaf {
  path: string;
  description: LocalizedText;
  options: HelpOption[];
  examples?: LocalizedText[];
}

export interface CommandInfo {
  name: string;
  description: LocalizedText;
  usage?: string;
  /**
   * The runnable paths this entry stands for, with their options: the entry
   * itself for a subcommand, every subcommand beneath it for a group.
   */
  leaves?: HelpLeaf[];
  /** Minimum permission level required to display. Multiple values are OR (any match shows). */
  requiredPermission?: PermissionLevel | PermissionLevel[];
  /**
   * The description of the top-level command this entry belongs to, when
   * the entry is one of its subcommands or groups (`community roulette`
   * under `/community`). Search ranks it below the entry's own text.
   */
  commandDescription?: LocalizedText;
  /** Search words the command declared for this entry (`CommandHelp.keywords`). */
  keywords?: LocalizedText[];
  /** Set when the command cannot run in a DM with the bot. */
  guildOnly?: true;
}

export interface CommandCategory {
  name: LocalizedText;
  commands: CommandInfo[];
}

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
/** `InteractionContextType.BotDM`. */
const BOT_DM_CONTEXT = 1;

type CommandJSON = RESTPostAPIChatInputApplicationCommandsJSONBody;
type Localizations = Partial<Record<string, string | null>> | null | undefined;

interface HelpEntry {
  path: string;
  description: LocalizedText;
  usage: string;
  leaves: HelpLeaf[];
}

function localized(text: string, localizations?: Localizations): LocalizedText {
  return { en: text, ja: localizations?.ja ?? text };
}

/** The fields of an option this catalog reads, whatever its type. */
interface OptionJSON {
  type: number;
  name: string;
  name_localizations?: Localizations;
  description: string;
  description_localizations?: Localizations;
  required?: boolean;
  choices?: Array<{ name: string; name_localizations?: Localizations }>;
}

function helpOptions(options: APIApplicationCommandOption[]): HelpOption[] {
  return (options as unknown as OptionJSON[])
    .filter(
      (option) => option.type !== SUBCOMMAND && option.type !== SUBCOMMAND_GROUP
    )
    .map((option) => ({
      name: localized(option.name, option.name_localizations),
      description: localized(
        option.description,
        option.description_localizations
      ),
      required: option.required === true,
      ...(option.choices?.length
        ? {
            choices: option.choices.map((choice) =>
              localized(choice.name, choice.name_localizations)
            ),
          }
        : {}),
    }));
}

/** Runnable subcommands beneath a group, depth first in definition order. */
function groupLeaves(
  options: APIApplicationCommandOption[],
  prefix: string
): HelpLeaf[] {
  const leaves: HelpLeaf[] = [];

  for (const option of options) {
    if (option.type === SUBCOMMAND_GROUP) {
      leaves.push(
        ...groupLeaves(
          (option.options ?? []) as APIApplicationCommandOption[],
          `${prefix} ${option.name}`
        )
      );
      continue;
    }

    if (option.type === SUBCOMMAND) {
      leaves.push({
        path: `${prefix} ${option.name}`,
        description: localized(
          option.description,
          option.description_localizations
        ),
        options: helpOptions(
          (option.options ?? []) as APIApplicationCommandOption[]
        ),
      });
    }
  }

  return leaves;
}

/**
 * One help entry per subcommand or subcommand group, matching how people
 * think about the commands; a command with no subcommands lists itself.
 */
function helpEntries(json: CommandJSON): HelpEntry[] {
  const options = (json.options ?? []) as APIApplicationCommandOption[];
  const entries: HelpEntry[] = [];

  for (const option of options) {
    if (option.type !== SUBCOMMAND && option.type !== SUBCOMMAND_GROUP) {
      continue;
    }

    const path = `${json.name} ${option.name}`;
    const description = localized(
      option.description,
      option.description_localizations
    );
    const leaves =
      option.type === SUBCOMMAND_GROUP
        ? groupLeaves(
            (option.options ?? []) as APIApplicationCommandOption[],
            path
          )
        : [
            {
              path,
              description,
              options: helpOptions(
                (option.options ?? []) as APIApplicationCommandOption[]
              ),
            },
          ];

    entries.push({
      path,
      description,
      usage: leaves.map((leaf) => `/${leaf.path}`).join(', '),
      leaves,
    });
  }

  if (entries.length > 0) return entries;

  const description = localized(
    json.description,
    json.description_localizations
  );
  return [
    {
      path: json.name,
      description,
      usage: `/${json.name}`,
      leaves: [{ path: json.name, description, options: helpOptions(options) }],
    },
  ];
}

/**
 * Permission level implied by the command's own declarations: the middleware
 * requirement it enforces, or the default member permission Discord applies.
 */
function derivePermission(
  command: Command,
  json: CommandJSON
): PermissionLevel {
  // Discord reads a default of "0" as "administrators only" (until a server
  // grants the command to someone in its integration settings), although the
  // value itself sets no permission bit.
  if (json.default_member_permissions === '0') return 'administrator';

  const bits = new PermissionsBitField();

  for (const permission of command.options?.permissions ?? []) {
    bits.add(permission);
  }
  if (json.default_member_permissions) {
    bits.add(BigInt(json.default_member_permissions));
  }

  if (bits.has(PermissionsBitField.Flags.ManageGuild)) return 'manageGuild';
  if (bits.has(PermissionsBitField.Flags.ManageRoles)) return 'manageRoles';
  return 'everyone';
}

/**
 * Whether Discord refuses the command in a DM with the bot: its contexts
 * leave out BotDM, or (the deprecated form) it denies DM use.
 */
function isGuildOnly(json: CommandJSON): boolean {
  if (Array.isArray(json.contexts)) {
    return !json.contexts.includes(BOT_DM_CONTEXT);
  }
  return json.dm_permission === false;
}

function toCommandInfos(command: Command): CommandInfo[] {
  const json = command.data.toJSON() as CommandJSON;
  const fallback = command.help?.permission ?? derivePermission(command, json);
  const examples = command.help?.examples ?? {};
  const keywords = command.help?.keywords ?? {};
  const commandDescription = localized(
    json.description,
    json.description_localizations
  );
  const guildOnly = isGuildOnly(json);

  return helpEntries(json).map((entry) => ({
    name: entry.path,
    description: entry.description,
    usage: entry.usage,
    leaves: entry.leaves.map((leaf) =>
      examples[leaf.path]?.length
        ? { ...leaf, examples: examples[leaf.path] }
        : leaf
    ),
    requiredPermission:
      command.help?.subcommandPermissions?.[entry.path] ?? fallback,
    // A command without subcommands is its own entry: its description is
    // already the entry's.
    ...(entry.path !== json.name ? { commandDescription } : {}),
    ...(keywords[entry.path]?.length ? { keywords: keywords[entry.path] } : {}),
    ...(guildOnly ? { guildOnly: true as const } : {}),
  }));
}

/**
 * Build the help catalog from the loaded commands.
 *
 * Names, descriptions, options and usage come from the same
 * SlashCommandBuilder definitions Discord receives, so the two cannot drift.
 * Only what the builder cannot express - a localized category, owner-only
 * visibility, worked examples, extra search words - is declared by the
 * command itself.
 */
export function buildHelpCatalog(
  commands: Iterable<Command>
): CommandCategory[] {
  const categories = new Map<string, CommandCategory>();

  for (const command of commands) {
    if (!command.help) continue;

    const key = command.help.category.en;
    let category = categories.get(key);
    if (!category) {
      category = { name: command.help.category, commands: [] };
      categories.set(key, category);
    }

    category.commands.push(...toCommandInfos(command));
  }

  return [...categories.values()];
}
