import { InteractionType } from 'discord.js';

/**
 * Clickable command mentions.
 *
 * `</voice record:123>` renders as a tappable `/voice record` chip, which
 * saves a mobile user from dismissing the reply and typing the path. The id
 * is the top-level command's, captured when commands are registered or
 * fetched at startup (`registerCommands`). Until then - or when registration
 * failed - mentions fall back to the plain `/path` code span, so wording never
 * depends on the ids being known.
 *
 * Mentions render in message content, embed descriptions and field values;
 * never in titles, field names or footers.
 */

const commandIds = new Map<string, string>();

/** Replace the known ids with what Discord reported for the command set. */
export function setCommandIds(
  commands: Iterable<{ name: string; id: string }>
): void {
  commandIds.clear();
  for (const { name, id } of commands) {
    if (name && id) commandIds.set(name, id);
  }
}

/** Id of a top-level command, when it is known. */
export function getCommandId(name: string): string | undefined {
  return commandIds.get(name);
}

/** Forget every id (tests, or before re-registering). */
export function clearCommandIds(): void {
  commandIds.clear();
}

function splitPath(path: string): string[] {
  return path.trim().replace(/^\//, '').split(/\s+/).filter(Boolean);
}

/**
 * `commandMention('voice record')` -> `</voice record:ID>` when the command's
 * id is known, otherwise `` `/voice record` ``. A leading slash is accepted.
 * Point at a leaf path: Discord does not render mentions of a group alone.
 */
export function commandMention(path: string): string {
  const parts = splitPath(path);
  const joined = parts.join(' ');
  const id = parts.length > 0 ? commandIds.get(parts[0]) : undefined;
  return id ? `</${joined}:${id}>` : `\`/${joined}\``;
}

type SubcommandReader = (required: boolean) => string | null;

/**
 * Full invoked path of a slash command: `voice autojoin exclude`, or just the
 * command name when it has no subcommands, or '' without a command name.
 * Tolerates interactions without an options resolver (test doubles).
 */
export function commandPathOf(interaction: {
  commandName: string;
  options?: unknown;
}): string {
  if (!interaction.commandName) return '';

  const options = interaction.options as
    | {
        getSubcommandGroup?: SubcommandReader;
        getSubcommand?: SubcommandReader;
      }
    | undefined;

  const read = (reader: SubcommandReader | undefined): string | null => {
    if (typeof reader !== 'function') return null;
    try {
      const value = reader.call(options, false);
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  };

  return [
    interaction.commandName,
    read(options?.getSubcommandGroup),
    read(options?.getSubcommand),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

/**
 * The slash command (with subcommands) a message replied to, such as
 * `admin settings view`, or '' when it replied to something else. Discord
 * also fills `message.interaction` on the reply to a button press, and there
 * the name is the button's customId (`admin-panel:backup`), so only
 * application commands count.
 */
export function originCommandPathOf(message: unknown): string {
  const origin = (
    message as
      | { interaction?: { type?: unknown; commandName?: unknown } | null }
      | null
      | undefined
  )?.interaction;
  if (!origin || origin.type !== InteractionType.ApplicationCommand) return '';
  return typeof origin.commandName === 'string'
    ? splitPath(origin.commandName).join(' ')
    : '';
}
