import {
  PermissionsBitField,
  type APIApplicationCommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { Command } from '../types/command.js';

export type PermissionLevel =
  'everyone' | 'manageGuild' | 'manageRoles' | 'owner';

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
}

export interface LocalizedText {
  en: string;
  ja: string;
}

export interface CommandInfo {
  name: string;
  description: LocalizedText;
  usage?: string;
  /** Minimum permission level required to display. Multiple values are OR (any match shows). */
  requiredPermission?: PermissionLevel | PermissionLevel[];
}

export interface CommandCategory {
  name: LocalizedText;
  commands: CommandInfo[];
}

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

type CommandJSON = RESTPostAPIChatInputApplicationCommandsJSONBody;

interface HelpEntry {
  path: string;
  description: LocalizedText;
  usage: string;
}

function localized(
  description: string,
  localizations?: Partial<Record<string, string | null>> | null
): LocalizedText {
  return { en: description, ja: localizations?.ja ?? description };
}

/** Leaf subcommand paths beneath an entry, for its usage line. */
function leafPaths(
  options: APIApplicationCommandOption[],
  prefix: string
): string[] {
  const paths: string[] = [];

  for (const option of options) {
    if (option.type === SUBCOMMAND_GROUP) {
      paths.push(
        ...leafPaths(
          (option.options ?? []) as APIApplicationCommandOption[],
          `${prefix} ${option.name}`
        )
      );
      continue;
    }

    if (option.type === SUBCOMMAND) {
      paths.push(`${prefix} ${option.name}`);
    }
  }

  return paths;
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
    const leaves =
      option.type === SUBCOMMAND_GROUP
        ? leafPaths(
            (option.options ?? []) as APIApplicationCommandOption[],
            path
          )
        : [path];

    entries.push({
      path,
      description: localized(
        option.description,
        option.description_localizations
      ),
      usage: leaves.map((leaf) => `/${leaf}`).join(', '),
    });
  }

  if (entries.length > 0) return entries;

  return [
    {
      path: json.name,
      description: localized(json.description, json.description_localizations),
      usage: `/${json.name}`,
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

function toCommandInfos(command: Command): CommandInfo[] {
  const json = command.data.toJSON() as CommandJSON;
  const fallback = command.help?.permission ?? derivePermission(command, json);

  return helpEntries(json).map((entry) => ({
    name: entry.path,
    description: entry.description,
    usage: entry.usage,
    requiredPermission:
      command.help?.subcommandPermissions?.[entry.path] ?? fallback,
  }));
}

/**
 * Build the help catalog from the loaded commands.
 *
 * Names, descriptions, and usage come from the same SlashCommandBuilder
 * definitions Discord receives, so the two cannot drift. Only what the builder
 * cannot express - a localized category and owner-only visibility - is
 * declared by the command itself.
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
