import {
  Collection,
  PermissionsBitField,
  type APIEmbed,
  type APIStringSelectComponent,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type PermissionResolvable,
} from 'discord.js';
import { vi } from 'vitest';
import type { CommandHelp } from '../../../shared/help/catalog.js';
import type { Command, SlashCommandData } from '../../../shared/types/index.js';

/**
 * Stand-ins for the slices of discord.js the general feature reads.
 *
 * `/general help` derives its catalog from `interaction.client.commands`, so
 * every interaction here carries a real `Collection` of commands built from
 * real `SlashCommandBuilder`s. The member's permissions are a real
 * `PermissionsBitField` because the visibility check uses `instanceof`.
 */

/** Must match the BOT_OWNER_IDS each test file loads the config with. */
export const OWNER_ID = 'owner-1';
export const USER_ID = 'user-1';
export const OTHER_USER_ID = 'user-2';

type MockFn = ReturnType<typeof vi.fn>;
type Listener = (arg: unknown) => unknown;

/** A command as the loader would register it; `execute` is never called. */
export function helpCommand(
  data: SlashCommandData,
  help?: CommandHelp,
  extra: Partial<Command> = {}
): Command {
  return {
    data,
    ...(help ? { help } : {}),
    execute: vi.fn().mockResolvedValue(undefined),
    ...extra,
  } as Command;
}

/**
 * Who is asking.
 * - `permissions`: the member's guild permissions; `null` means no member
 *   object at all (DMs). Omit for a member with no permissions.
 * - `rawMember`: replaces the member wholesale (e.g. an API member whose
 *   permissions arrive as a string).
 * - `inGuild: false` drops the guild as well (DMs).
 */
export interface AskerOptions {
  userId?: string;
  inGuild?: boolean;
  permissions?: PermissionResolvable | null;
  rawMember?: unknown;
}

function asker(options: AskerOptions) {
  const userId = options.userId ?? USER_ID;
  const inGuild = options.inGuild ?? true;

  let member: unknown;
  if (options.rawMember !== undefined) {
    member = options.rawMember;
  } else if (options.permissions === null || !inGuild) {
    member = null;
  } else {
    member = {
      permissions: new PermissionsBitField(options.permissions ?? 0n),
    };
  }

  return {
    user: { id: userId, tag: `${userId}#0001` },
    guild: inGuild ? { id: 'guild-1' } : null,
    guildId: inGuild ? 'guild-1' : null,
    member,
  };
}

/**
 * A reply mock resolving like `reply({ withResponse: true })` with a message
 * that can host a component collector. The collector's callbacks are
 * captured so a test can fire components and the timeout by hand.
 */
export function panelReply() {
  const listeners = new Map<string, Listener>();
  const createMessageComponentCollector = vi.fn(() => ({
    on: (event: string, listener: Listener) => {
      listeners.set(event, listener);
    },
  }));
  const reply = vi.fn().mockResolvedValue({
    resource: { message: { createMessageComponentCollector } },
  });

  return {
    reply,
    createMessageComponentCollector,
    collect: async (component: unknown) => {
      await listeners.get('collect')?.(component);
    },
    end: async () => {
      await listeners.get('end')?.(undefined);
    },
  };
}

export interface ChatInteractionOptions extends AskerOptions {
  commands?: Command[];
  subcommand?: string | null;
  /** Value of the `command` string option of `/general help`. */
  commandOption?: string | null;
  createdTimestamp?: number;
  wsPing?: number;
  reply?: MockFn;
  deferReply?: MockFn;
  editReply?: MockFn;
}

export interface ChatInteractionStub {
  interaction: ChatInputCommandInteraction;
  reply: MockFn;
  deferReply: MockFn;
  editReply: MockFn;
}

export function chatInteraction(
  options: ChatInteractionOptions = {}
): ChatInteractionStub {
  const reply = options.reply ?? vi.fn().mockResolvedValue({});
  const deferReply = options.deferReply ?? vi.fn().mockResolvedValue({});
  const editReply = options.editReply ?? vi.fn().mockResolvedValue({});
  const commands = new Collection<string, Command>(
    (options.commands ?? []).map((command) => [command.data.name, command])
  );

  const interaction = {
    id: 'interaction-1',
    ...asker(options),
    locale: 'en-US',
    createdTimestamp: options.createdTimestamp ?? 0,
    client: { commands, ws: { ping: options.wsPing ?? 0 } },
    options: {
      getSubcommand: vi.fn().mockReturnValue(options.subcommand ?? null),
      getString: vi.fn((name: string) =>
        name === 'command' ? (options.commandOption ?? null) : null
      ),
    },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, reply, deferReply, editReply };
}

export interface AutocompleteStub {
  interaction: AutocompleteInteraction;
  respond: MockFn;
}

export function autocompleteInteraction(
  options: AskerOptions & { commands?: Command[]; focused?: string } = {}
): AutocompleteStub {
  const respond = vi.fn().mockResolvedValue(undefined);
  const commands = new Collection<string, Command>(
    (options.commands ?? []).map((command) => [command.data.name, command])
  );

  const interaction = {
    ...asker(options),
    locale: 'en-US',
    client: { commands },
    options: { getFocused: vi.fn().mockReturnValue(options.focused ?? '') },
    respond,
  } as unknown as AutocompleteInteraction;

  return { interaction, respond };
}

/** A component interaction arriving on the help panel's collector. */
export function selectComponent(values: string[], userId = USER_ID) {
  return {
    user: { id: userId },
    customId: 'help_category',
    values,
    isStringSelectMenu: () => true,
    update: vi.fn().mockResolvedValue({}),
    reply: vi.fn().mockResolvedValue({}),
    deferUpdate: vi.fn().mockResolvedValue({}),
  };
}

/** A non-select component (e.g. a stray button) on the same message. */
export function buttonComponent(userId = USER_ID) {
  return {
    ...selectComponent([], userId),
    customId: 'help_button',
    isStringSelectMenu: () => false,
  };
}

interface Serializable<T> {
  toJSON(): T;
}

export interface SentPayload {
  embeds?: Serializable<APIEmbed>[];
  components?: Serializable<{ components: unknown[] }>[];
  content?: string;
  flags?: number;
  withResponse?: boolean;
}

/** The payload passed in `call` of a reply/editReply/update mock. */
export function payloadAt(mock: MockFn, call = 0): SentPayload {
  return mock.mock.calls[call][0] as SentPayload;
}

/** The first embed of the payload passed in `call`. */
export function embedAt(mock: MockFn, call = 0): APIEmbed {
  const embeds = payloadAt(mock, call).embeds;
  if (!embeds?.length) throw new Error(`call ${call} sent no embed`);
  return embeds[0].toJSON();
}

/** The select menu in the first action row of the payload passed in `call`. */
export function selectMenuAt(mock: MockFn, call = 0): APIStringSelectComponent {
  const rows = payloadAt(mock, call).components;
  if (!rows?.length) throw new Error(`call ${call} sent no components`);
  return rows[0].toJSON().components[0] as APIStringSelectComponent;
}

/** Character count Discord applies to its 6000-per-embed limit. */
export function embedTextLength(embed: APIEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce(
      (total, field) => total + field.name.length + field.value.length,
      0
    )
  );
}
