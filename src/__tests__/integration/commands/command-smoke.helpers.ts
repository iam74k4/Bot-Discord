import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApplicationCommandOptionType,
  ButtonStyle,
  ChannelType,
  Collection,
  CommandInteractionOptionResolver,
  ComponentType,
  GuildMember,
  InteractionContextType,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  type APIEmbed,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type CommandInteractionOption,
  type Guild,
  type PermissionResolvable,
  type User,
} from 'discord.js';
import { vi, type Mock } from 'vitest';
import {
  discoverFeatureCommands,
  type DiscoveredCommand,
} from '../../../app/interactions/commandRegistry.js';
import type { Command } from '../../../shared/types/index.js';
import type { ExtendedClient } from '../../../client.js';
import { en } from '../../../locales/en.js';

/**
 * Shared machinery for the cross-feature command tests.
 *
 * Everything here is driven by the commands the real registry discovers, so
 * a command added under `src/features/<feature>/commands/` is picked up by
 * both `commandPayload.test.ts` and `allCommands.smoke.test.ts` without any
 * edit to either file.
 *
 * The Discord side is faked just far enough for the real application code to
 * run: option parsing uses discord.js's own `CommandInteractionOptionResolver`
 * (so a wrong getter or a missing required option throws exactly as it would
 * in production), and the interaction enforces Discord's response rules (one
 * initial response; edits and follow-ups only after it).
 */

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const FEATURES_DIR = fileURLToPath(
  new URL('../../../features', import.meta.url)
);

/** Localized strings as Discord's REST JSON carries them. */
export type Localizations = Partial<Record<string, string | null>> | null;

export interface LooseChoice {
  name: string;
  name_localizations?: Localizations;
  value: string | number;
}

/**
 * One option of a command's REST JSON. discord-api-types models this as a
 * deep discriminated union; the checks here walk every kind uniformly, so a
 * single structural view keeps them readable.
 */
export interface LooseOption {
  type: ApplicationCommandOptionType;
  name: string;
  name_localizations?: Localizations;
  description: string;
  description_localizations?: Localizations;
  required?: boolean;
  autocomplete?: boolean;
  choices?: LooseChoice[];
  options?: LooseOption[];
  channel_types?: ChannelType[];
  min_length?: number;
  max_length?: number;
  min_value?: number;
  max_value?: number;
}

export interface CommandJSON {
  type?: number;
  name: string;
  name_localizations?: Localizations;
  description: string;
  description_localizations?: Localizations;
  options?: LooseOption[];
  default_member_permissions?: string | null;
  contexts?: number[] | null;
  integration_types?: number[];
  nsfw?: boolean;
}

export interface LoadedCommand extends DiscoveredCommand {
  json: CommandJSON;
}

/**
 * Feature folders that ship command files, read straight from disk so the
 * registry's own discovery can be checked against it.
 */
export function featuresWithCommandFiles(): string[] {
  return readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((feature) => {
      const dir = join(FEATURES_DIR, feature, 'commands');
      return (
        existsSync(dir) &&
        readdirSync(dir).some(
          (file) => /\.(ts|js)$/.test(file) && !file.startsWith('index.')
        )
      );
    })
    .sort();
}

/** Every command the real registry finds, with its REST JSON, by name. */
export async function loadCommands(): Promise<LoadedCommand[]> {
  const discovered = await discoverFeatureCommands(FEATURES_DIR);
  return discovered
    .map((entry) => ({
      ...entry,
      json: entry.command.data.toJSON() as unknown as CommandJSON,
    }))
    .sort((a, b) => a.json.name.localeCompare(b.json.name));
}

/** A runnable leaf: a command, or one of its subcommands. */
export interface CommandPath {
  /** As a user types it, e.g. `admin settings view`. */
  label: string;
  entry: LoadedCommand;
  group: string | null;
  subcommand: string | null;
  /** The leaf's own (non-subcommand) options. */
  options: LooseOption[];
}

function isNesting(option: LooseOption): boolean {
  return (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  );
}

/** Every leaf path of every command, in a stable order. */
export function commandPaths(
  commands: readonly LoadedCommand[]
): CommandPath[] {
  const paths: CommandPath[] = [];

  for (const entry of commands) {
    const name = entry.json.name;
    const top = entry.json.options ?? [];

    if (!top.some(isNesting)) {
      paths.push({
        label: name,
        entry,
        group: null,
        subcommand: null,
        options: top,
      });
      continue;
    }

    for (const option of top) {
      if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const sub of option.options ?? []) {
          paths.push({
            label: `${name} ${option.name} ${sub.name}`,
            entry,
            group: option.name,
            subcommand: sub.name,
            options: sub.options ?? [],
          });
        }
      } else if (option.type === ApplicationCommandOptionType.Subcommand) {
        paths.push({
          label: `${name} ${option.name}`,
          entry,
          group: null,
          subcommand: option.name,
          options: option.options ?? [],
        });
      }
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Policy: who may use what, declared by hand
// ---------------------------------------------------------------------------

/** Who may run a help entry; `owner` means a configured bot owner. */
export type AccessLevel = 'everyone' | 'manageGuild' | 'manageRoles' | 'owner';

export interface CommandPolicy {
  /** Discord's `default_member_permissions`: who sees it in the picker. */
  defaultMemberPermissions: bigint | null;
  /** Where Discord offers it, or null for Discord's default (everywhere). */
  contexts: readonly InteractionContextType[] | null;
  /** Per-user cooldown the middleware enforces, or null for none. */
  cooldownMs: number | null;
  /** Options that autocomplete, as `<path> <option>`. */
  autocomplete: readonly string[];
  /** Who may run each `/general help` entry (subcommand or group). */
  access: Readonly<Record<string, AccessLevel>>;
}

/**
 * The intended access and deployment policy of every command, written down
 * separately from the code that implements it.
 *
 * The help catalog derives its permission levels from the same
 * `options.permissions` the middleware enforces, so a test that only checks
 * "behaviour matches help" stays green when a requirement is dropped from
 * both at once (anyone could then record other people's audio). Tests check
 * the code, the help catalog and the observed behaviour against this table
 * instead. It is deliberately exhaustive: a new command fails the policy test
 * until someone states, on purpose, who may use it.
 */
export const COMMAND_POLICY: Readonly<Record<string, CommandPolicy>> = {
  admin: {
    defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
    contexts: null,
    cooldownMs: null,
    autocomplete: [],
    access: {
      'admin settings': 'manageGuild',
      'admin role': 'manageRoles',
    },
  },
  community: {
    defaultMemberPermissions: null,
    contexts: null,
    // Guards the roulette animation against spam.
    cooldownMs: 10_000,
    autocomplete: [],
    access: {
      'community poll': 'everyone',
      'community roulette': 'everyone',
    },
  },
  general: {
    defaultMemberPermissions: null,
    contexts: null,
    cooldownMs: 3_000,
    autocomplete: ['general help command'],
    access: {
      'general help': 'everyone',
      'general ping': 'everyone',
      'general about': 'everyone',
    },
  },
  notification: {
    defaultMemberPermissions: null,
    contexts: [InteractionContextType.Guild],
    cooldownMs: null,
    autocomplete: [],
    access: {
      'notification voice': 'manageGuild',
      'notification welcome': 'manageGuild',
      'notification status': 'manageGuild',
      'notification stats': 'everyone',
    },
  },
  owner: {
    defaultMemberPermissions: null,
    // Owners run it from a DM with the bot too.
    contexts: [
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ],
    cooldownMs: null,
    autocomplete: [],
    access: {
      'owner system': 'owner',
      'owner backup': 'owner',
    },
  },
  tts: {
    defaultMemberPermissions: null,
    contexts: [InteractionContextType.Guild],
    cooldownMs: 2_000,
    autocomplete: ['tts voice speaker', 'tts dict remove word'],
    // Reading is for people who cannot or would rather not speak, so no
    // permission gates it. Narrower rules depend on state rather than on a
    // permission, and are enforced (and unit-tested) in the application:
    // stop/skip need the caller in the voice channel being read or Manage
    // Server, and removing a dictionary word needs its author or Manage
    // Server. The smoke scenarios put the caller on the allowed side.
    access: {
      'tts start': 'everyone',
      'tts stop': 'everyone',
      'tts skip': 'everyone',
      'tts voice': 'everyone',
      'tts dict': 'everyone',
    },
  },
  voice: {
    defaultMemberPermissions: null,
    contexts: null,
    cooldownMs: 10_000,
    autocomplete: [],
    // Recording captures other people's voices: never open to everyone.
    access: {
      'voice record': 'manageGuild',
      'voice status': 'manageGuild',
      'voice autojoin': 'manageGuild',
    },
  },
};

/**
 * Levels `/general help` shows an entry to beyond its `access`, keyed by
 * entry. Production bug: `/admin` declares one help permission,
 * `['manageGuild', 'manageRoles']`, for both of its groups, but `settings`
 * needs Manage Server and `role` needs Manage Roles, so help lists each group
 * to members it then refuses. Delete an entry once help is precise
 * (`subcommandPermissions` per group).
 */
export const KNOWN_HELP_OVERREACH: Readonly<
  Record<string, readonly AccessLevel[]>
> = {
  'admin settings': ['manageRoles'],
  'admin role': ['manageGuild'],
};

/** The `/general help` entry a path is listed under. */
export function helpEntryOf(path: {
  label: string;
  subcommand: string | null;
}): string {
  const tokens = path.label.split(' ');
  return path.subcommand === null ? tokens[0]! : tokens.slice(0, 2).join(' ');
}

/** The declared access level of a path, if its command has a policy. */
export function declaredAccess(path: CommandPath): AccessLevel | undefined {
  return COMMAND_POLICY[path.entry.json.name]?.access[helpEntryOf(path)];
}

/** The cooldown middleware's default when a command declares none. */
export const DEFAULT_COOLDOWN_MS = 3_000;

/** The cooldown a command actually gets from its middleware, if any. */
export function effectiveCooldown(command: Command): number | null {
  if (!command.middleware?.includes('cooldown')) return null;
  const cooldown = command.options?.cooldown ?? DEFAULT_COOLDOWN_MS;
  return cooldown > 0 ? cooldown : null;
}

/** Whether Discord delivers the command from a DM with the bot. */
export function reachableFromBotDM(
  contexts: readonly number[] | null | undefined
): boolean {
  return !contexts || contexts.includes(InteractionContextType.BotDM);
}

// ---------------------------------------------------------------------------
// A small, consistent guild for commands to run in
// ---------------------------------------------------------------------------

export const IDS = {
  guild: '300000000000000001',
  guildOwner: '300000000000000002',
  target: '300000000000000003',
  friendA: '300000000000000004',
  friendB: '300000000000000005',
  friendC: '300000000000000012',
  friendD: '300000000000000013',
  friendE: '300000000000000014',
  bot: '300000000000000006',
  role: '300000000000000007',
  text: '300000000000000008',
  voice: '300000000000000009',
  dm: '300000000000000010',
  member: '300000000000000011',
} as const;

export interface RoleStub {
  id: string;
  name: string;
  position: number;
  toString(): string;
}

export interface MemberStub {
  id: string;
  user: User;
  guild: Guild;
  displayName: string;
  nickname: null;
  permissions: PermissionsBitField;
  roles: {
    highest: { position: number };
    cache: Collection<string, RoleStub>;
    add: Mock;
    remove: Mock;
  };
  voice: { channel: VoiceChannelStub | null; channelId: string | null };
  toString(): string;
}

export interface VoiceChannelStub {
  id: string;
  name: string;
  type: ChannelType.GuildVoice;
  guild: Guild;
  guildId: string;
  members: Collection<string, GuildMember>;
  permissionsFor: Mock;
  isTextBased(): boolean;
  isVoiceBased(): boolean;
  toString(): string;
}

/** A message `channel.messages.fetch` can hand back, e.g. one with a poll. */
export interface FetchableMessage {
  id: string;
  [key: string]: unknown;
}

export interface SmokeWorld {
  ownerId: string;
  client: ExtendedClient;
  guild: Guild;
  role: RoleStub;
  actor: GuildMember & MemberStub;
  target: GuildMember & MemberStub;
  botMember: GuildMember & MemberStub;
  textChannel: TextChannel & { send: Mock };
  voiceChannel: VoiceChannelStub;
  dmChannel: { id: string; type: ChannelType.DM; send: Mock };
  /** What `messages.fetch(id)` resolves in the text channel. */
  messages: Map<string, FetchableMessage>;
}

function userStub(id: string, username: string, bot = false): User {
  return {
    id,
    username,
    globalName: username,
    displayName: username,
    tag: `${username}#0`,
    discriminator: '0',
    bot,
    system: false,
    avatar: null,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    toString: () => `<@${id}>`,
  } as unknown as User;
}

function memberStub(
  guild: Guild,
  user: User,
  highestRole: number,
  permissions: PermissionResolvable
): GuildMember & MemberStub {
  const roles = new Collection<string, RoleStub>();
  const member: MemberStub = {
    id: user.id,
    user,
    guild,
    displayName: user.username,
    nickname: null,
    permissions: new PermissionsBitField(permissions),
    roles: {
      highest: { position: highestRole },
      cache: roles,
      add: vi.fn(async (role: string | RoleStub) => {
        const id = typeof role === 'string' ? role : role.id;
        const known = guild.roles.cache.get(id) as RoleStub | undefined;
        roles.set(id, known ?? { id, name: id, position: 0 });
        return member;
      }),
      remove: vi.fn(async (role: string | RoleStub) => {
        roles.delete(typeof role === 'string' ? role : role.id);
        return member;
      }),
    },
    voice: { channel: null, channelId: null },
    toString: () => `<@${user.id}>`,
  };
  // A real prototype so `instanceof GuildMember` checks pass; the own
  // properties above shadow the prototype's getters.
  Object.setPrototypeOf(member, GuildMember.prototype);
  return member as GuildMember & MemberStub;
}

/** Everything a bot needs in a text channel to post, embed and attach. */
const TEXT_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
];

export interface WorldOptions {
  /**
   * Guild permissions of the invoking member. Defaults to Manage Server and
   * Manage Roles, everything a command in this bot asks for.
   */
  permissions?: readonly bigint[];
  /** Whether the invoking user is a configured bot owner (default: yes). */
  owner?: boolean;
  /** `false` is shorthand for no permissions and not an owner. */
  privileged?: boolean;
}

/**
 * A guild where every command has what it needs to reach its main flow: the
 * invoking member can manage the server and roles and sits in a voice channel
 * the bot is buffering, with five other people (enough for the largest team
 * split a command offers); the bot outranks everyone involved and can post in
 * the text channel; one other member (`target`) is available for user options
 * and sits below the invoking member in the hierarchy.
 *
 * The invoking user is a configured bot owner so `/owner` runs too. Options
 * narrow that down - a plain member, or one holding a single permission - for
 * checking that commands refuse cleanly. A non-owner invokes with a different
 * user id, so cooldowns and records never leak between the two.
 */
export function createWorld(
  ownerId: string,
  options: WorldOptions = {}
): SmokeWorld {
  const privileged = options.privileged ?? true;
  const isOwner = options.owner ?? privileged;
  const permissions =
    options.permissions ??
    (privileged
      ? [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles]
      : []);
  const guild = {
    id: IDS.guild,
    name: 'Smoke Test Guild',
    ownerId: IDS.guildOwner,
    memberCount: 8,
    preferredLocale: 'en-US',
    available: true,
    toString: () => 'Smoke Test Guild',
  } as unknown as Guild;

  const role: RoleStub = {
    id: IDS.role,
    name: 'Smoke Role',
    position: 5,
    toString: () => `<@&${IDS.role}>`,
  };

  const users = {
    actor: isOwner
      ? userStub(ownerId, 'smoke-owner')
      : userStub(IDS.member, 'smoke-member'),
    target: userStub(IDS.target, 'smoke-target'),
    friendA: userStub(IDS.friendA, 'smoke-friend-a'),
    friendB: userStub(IDS.friendB, 'smoke-friend-b'),
    friendC: userStub(IDS.friendC, 'smoke-friend-c'),
    friendD: userStub(IDS.friendD, 'smoke-friend-d'),
    friendE: userStub(IDS.friendE, 'smoke-friend-e'),
    bot: userStub(IDS.bot, 'SmokeBot', true),
  };

  const botMember = memberStub(guild, users.bot, 50, PermissionsBitField.All);
  const actor = memberStub(guild, users.actor, 10, [...permissions]);
  const target = memberStub(guild, users.target, 1, []);
  const friends = [
    users.friendA,
    users.friendB,
    users.friendC,
    users.friendD,
    users.friendE,
  ].map((user) => memberStub(guild, user, 1, []));
  const inVoice = [actor, ...friends, botMember];
  const members = new Collection<string, GuildMember>(
    [actor, target, ...friends, botMember].map((m) => [m.id, m])
  );

  const voiceChannel: VoiceChannelStub = {
    id: IDS.voice,
    name: 'Smoke Voice',
    type: ChannelType.GuildVoice,
    guild,
    guildId: guild.id,
    members: new Collection<string, GuildMember>(inVoice.map((m) => [m.id, m])),
    permissionsFor: vi.fn(
      () => new PermissionsBitField(PermissionsBitField.All)
    ),
    isTextBased: () => false,
    isVoiceBased: () => true,
    toString: () => `<#${IDS.voice}>`,
  };
  for (const member of inVoice as MemberStub[]) {
    member.voice = { channel: voiceChannel, channelId: voiceChannel.id };
  }

  const messages = new Map<string, FetchableMessage>();
  const textChannelData = {
    id: IDS.text,
    name: 'smoke-text',
    type: ChannelType.GuildText,
    guild,
    guildId: guild.id,
    permissionsFor: vi.fn(
      () => new PermissionsBitField(TEXT_CHANNEL_PERMISSIONS)
    ),
    send: vi.fn(async () => ({ id: '300000000000000099' })),
    isTextBased: () => true,
    isVoiceBased: () => false,
    isDMBased: () => false,
    isSendable: () => true,
    messages: {
      fetch: vi.fn(async (id: string) => {
        const message = messages.get(id);
        if (!message) throw new Error('Unknown Message');
        return message;
      }),
    },
    toString: () => `<#${IDS.text}>`,
  };
  Object.setPrototypeOf(textChannelData, TextChannel.prototype);
  const textChannel = textChannelData as unknown as TextChannel & {
    send: Mock;
  };

  const channels = new Collection<string, unknown>([
    [textChannel.id, textChannel],
    [voiceChannel.id, voiceChannel],
  ]);

  Object.assign(guild, {
    members: {
      me: botMember,
      cache: members,
      fetch: vi.fn(async (id?: string) => {
        if (id === undefined) return members;
        const member = members.get(id);
        if (!member) throw new Error('Unknown Member');
        return member;
      }),
    },
    roles: {
      cache: new Collection<string, RoleStub>([[role.id, role]]),
      highest: { position: 100 },
    },
    channels: {
      cache: channels,
      fetch: vi.fn(async (id: string) => {
        const channel = channels.get(id);
        if (!channel) throw new Error('Unknown Channel');
        return channel;
      }),
    },
  });

  const usersById = new Collection<string, User>(
    Object.values(users).map((u) => [u.id, u])
  );

  const client = {
    user: users.bot,
    application: { id: IDS.bot },
    guilds: { cache: new Collection<string, Guild>([[guild.id, guild]]) },
    channels: { cache: channels },
    users: {
      cache: usersById,
      fetch: vi.fn(async (id: string) => {
        const user = usersById.get(id);
        if (!user) throw new Error('Unknown User');
        return user;
      }),
    },
    ws: { ping: 42 },
    uptime: 60_000,
    readyAt: new Date(0),
    isReady: () => true,
    isFullyReady: true,
    commands: new Collection<string, Command>(),
  } as unknown as SmokeWorld['client'];

  const dmChannel = {
    id: IDS.dm,
    type: ChannelType.DM as const,
    send: vi.fn(async () => ({ id: '300000000000000098' })),
    isTextBased: () => true,
    isDMBased: () => true,
    isSendable: () => true,
    messages: { fetch: vi.fn(async () => Promise.reject(new Error('x'))) },
  };

  return {
    ownerId,
    client,
    guild,
    role,
    actor,
    target,
    botMember,
    textChannel,
    voiceChannel,
    dmChannel,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Option values
// ---------------------------------------------------------------------------

/**
 * Which options an invocation fills, and with what:
 * - `required`: only required options, with ordinary values;
 * - `all`: every option, with ordinary values;
 * - `max`: every option at the top of what Discord lets a user send - strings
 *   at `max_length` (Discord's 6000 when unbounded), numbers at `max_value`,
 *   the last choice;
 * - `min`: every option at the bottom - one-character strings (or
 *   `min_length`), numbers at `min_value`, the first choice, `false`.
 *
 * The boundary fills are what catch a declared limit the code (or Discord's
 * message limits) cannot actually take, such as a 301-char poll question.
 */
export type OptionFill = 'required' | 'all' | 'max' | 'min';

/** Discord's own bounds when an option declares none. */
export const DISCORD_OPTION_BOUNDS = {
  maxStringLength: 6000,
  minInteger: -(2 ** 53) + 1,
  maxInteger: 2 ** 53 - 1,
} as const;

/** A string that satisfies the option's length bounds. */
export function sampleText(minLength = 0, maxLength = 6000): string {
  const base = 'Smoke test value';
  const length = Math.min(Math.max(base.length, minLength, 1), maxLength);
  return base.padEnd(length, '.').slice(0, length);
}

/**
 * Exactly `length` characters, starting with `label` so that sibling options
 * filled to the same length (poll answers, say) still differ, as a real
 * user's would.
 */
export function textOfLength(label: string, length: number): string {
  const seed = `${label} `;
  return seed
    .repeat(Math.ceil(length / seed.length))
    .slice(0, length)
    .padEnd(length, '.');
}

function sampleNumber(option: LooseOption, fill: OptionFill): number {
  if (fill === 'max') {
    return option.max_value ?? DISCORD_OPTION_BOUNDS.maxInteger;
  }
  if (fill === 'min') {
    return option.min_value ?? DISCORD_OPTION_BOUNDS.minInteger;
  }
  let value = 1;
  if (option.min_value !== undefined) value = Math.max(value, option.min_value);
  if (option.max_value !== undefined) value = Math.min(value, option.max_value);
  return value;
}

function sampleString(option: LooseOption, fill: OptionFill): string {
  if (fill === 'max') {
    return textOfLength(
      option.name,
      option.max_length ?? DISCORD_OPTION_BOUNDS.maxStringLength
    );
  }
  if (fill === 'min') {
    return textOfLength(option.name, Math.max(option.min_length ?? 1, 1));
  }
  return sampleText(option.min_length, option.max_length);
}

/** A channel from the world whose type the option accepts. */
function sampleChannel(world: SmokeWorld, option: LooseOption): unknown {
  const accepted = option.channel_types ?? [];
  const candidates: Array<{ type: ChannelType }> = [
    world.textChannel,
    world.voiceChannel,
  ];
  return (
    candidates.find((channel) => accepted.includes(channel.type)) ??
    world.textChannel
  );
}

/**
 * A plausible value for one option, already resolved the way discord.js
 * hands it to `CommandInteractionOptionResolver` (user, member, channel, …).
 *
 * With choices, the first one wins (the last one for `max`); an autocomplete
 * option takes the command's own first suggestion when the caller collected
 * one, since Discord only sends what the user picked from it.
 */
export function sampleOption(
  world: SmokeWorld,
  option: LooseOption,
  inGuild: boolean,
  suggestions?: ReadonlyMap<string, string | number>,
  fill: OptionFill = 'all'
): CommandInteractionOption {
  const base = { name: option.name, type: option.type };
  const choices = option.choices ?? [];
  const choice = (fill === 'max' ? choices.at(-1) : choices[0])?.value;
  const suggestion = suggestions?.get(option.name);

  switch (option.type) {
    case ApplicationCommandOptionType.String:
      return {
        ...base,
        value:
          choice ??
          (typeof suggestion === 'string'
            ? suggestion
            : sampleString(option, fill)),
      };
    case ApplicationCommandOptionType.Integer:
    case ApplicationCommandOptionType.Number:
      return {
        ...base,
        value:
          choice ??
          (typeof suggestion === 'number'
            ? suggestion
            : sampleNumber(option, fill)),
      };
    case ApplicationCommandOptionType.Boolean:
      return { ...base, value: fill !== 'min' };
    case ApplicationCommandOptionType.User:
    case ApplicationCommandOptionType.Mentionable:
      return {
        ...base,
        value: world.target.id,
        user: world.target.user,
        ...(inGuild ? { member: world.target } : {}),
      } as CommandInteractionOption;
    case ApplicationCommandOptionType.Channel: {
      const channel = sampleChannel(world, option) as { id: string };
      return {
        ...base,
        value: channel.id,
        channel,
      } as CommandInteractionOption;
    }
    case ApplicationCommandOptionType.Role:
      return {
        ...base,
        value: world.role.id,
        role: world.role,
      } as unknown as CommandInteractionOption;
    case ApplicationCommandOptionType.Attachment:
      return {
        ...base,
        value: '300000000000000097',
        attachment: {
          id: '300000000000000097',
          name: 'smoke.txt',
          url: 'https://cdn.discordapp.com/attachments/0/0/smoke.txt',
          size: 16,
          contentType: 'text/plain',
        },
      } as unknown as CommandInteractionOption;
    default:
      throw new Error(
        `No sample value for option "${option.name}" of type ${option.type}`
      );
  }
}

/** Nest leaf option values under the path's subcommand (and group). */
function nestUnderPath(
  path: CommandPath,
  leaf: CommandInteractionOption[]
): CommandInteractionOption[] {
  if (path.subcommand === null) return leaf;
  const sub: CommandInteractionOption = {
    name: path.subcommand,
    type: ApplicationCommandOptionType.Subcommand,
    options: leaf,
  };
  if (path.group === null) return [sub];
  return [
    {
      name: path.group,
      type: ApplicationCommandOptionType.SubcommandGroup,
      options: [sub],
    },
  ];
}

type ResolverConstructor = new (
  client: Client,
  options: CommandInteractionOption[],
  resolved: object
) => CommandInteractionOptionResolver;

/**
 * discord.js's real resolver (its constructor is private in the typings),
 * wrapped so every option name the command asks for is recorded.
 */
function createResolver(
  client: Client,
  data: CommandInteractionOption[],
  reads: Set<string>
): CommandInteractionOptionResolver {
  const Resolver =
    CommandInteractionOptionResolver as unknown as ResolverConstructor;
  const resolver = new Resolver(client, data, {});
  const get = resolver.get.bind(resolver);
  Object.defineProperty(resolver, 'get', {
    value: (name: string, required?: boolean) => {
      reads.add(name);
      return get(name, required);
    },
  });
  return resolver;
}

// ---------------------------------------------------------------------------
// Invoking a command
// ---------------------------------------------------------------------------

export type ResponseKind =
  | 'reply'
  | 'deferReply'
  | 'showModal'
  | 'editReply'
  | 'followUp'
  | 'deleteReply'
  | 'component.update'
  | 'component.reply';

export interface SentPayload {
  via: ResponseKind;
  payload: unknown;
}

export interface Invocation {
  interaction: ChatInputCommandInteraction;
  /** Every attempt at an initial response, in order. */
  initialResponses: ResponseKind[];
  /** Calls Discord would have rejected (double reply, edit before reply). */
  violations: string[];
  /** Everything sent through the interaction, in order. */
  sent: SentPayload[];
  /** Option names the command read. */
  optionReads: Set<string>;
  /** The leaf option names the command declares. */
  declaredOptions: Set<string>;
  /** Calls that failed because of `failFirst`. */
  injectedFailures: ResponseKind[];
}

export interface InvokeOptions {
  fill: OptionFill;
  locale: string;
  inGuild: boolean;
  suggestions?: ReadonlyMap<string, string | number>;
  /**
   * Make Discord reject one call, as a 500 or an expired token would: the
   * first initial response (`reply` / `deferReply` / `showModal`), or the
   * first `editReply` of an acknowledged interaction. The call after it
   * succeeds. `injectedFailures` records whether it fired.
   */
  failFirst?: 'initialResponse' | 'editReply';
}

/** The error Discord's API hands back for an injected failure. */
export const INJECTED_FAILURE = 'Injected Discord API failure';

let snowflakeCounter = 0;
function nextSnowflake(): string {
  snowflakeCounter++;
  return `31${String(snowflakeCounter).padStart(16, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The custom id of a "confirm" button in a set of action rows, if any. */
function confirmButtonIn(components: readonly unknown[]): string | null {
  for (const row of serializeRows(components).rows) {
    for (const component of row.components) {
      if (
        component.type === ComponentType.Button &&
        typeof component.custom_id === 'string' &&
        /^confirm/i.test(component.custom_id)
      ) {
        return component.custom_id;
      }
    }
  }
  return null;
}

/**
 * A chat input interaction for `path`, with its options filled per `fill`.
 *
 * Responses follow Discord's rules: the first `reply` / `deferReply` /
 * `showModal` acknowledges the interaction and any second one rejects, while
 * `editReply` / `followUp` reject until it has been acknowledged. A reply
 * that carries a "confirm" button is answered by the invoking user pressing
 * it, so confirmation flows run through to the action they guard.
 */
export function invokeCommand(
  world: SmokeWorld,
  path: CommandPath,
  options: InvokeOptions
): Invocation {
  const { inGuild } = options;
  const optionReads = new Set<string>();
  const initialResponses: ResponseKind[] = [];
  const violations: string[] = [];
  const sent: SentPayload[] = [];
  const injectedFailures: ResponseKind[] = [];
  const state = { replied: false, deferred: false };
  let lastComponents: readonly unknown[] = [];
  let pendingFailure = options.failFirst;

  const maybeFail = (kind: ResponseKind) => {
    const initial =
      kind === 'reply' || kind === 'deferReply' || kind === 'showModal';
    if (
      (pendingFailure === 'initialResponse' && initial) ||
      (pendingFailure === 'editReply' && kind === 'editReply')
    ) {
      pendingFailure = undefined;
      injectedFailures.push(kind);
      throw new Error(INJECTED_FAILURE);
    }
  };

  const leaf = path.options
    .filter((option) => option.required || options.fill !== 'required')
    .map((option) =>
      sampleOption(world, option, inGuild, options.suggestions, options.fill)
    );
  const resolver = createResolver(
    world.client,
    nestUnderPath(path, leaf),
    optionReads
  );

  const channel = inGuild ? world.textChannel : world.dmChannel;

  const record = (via: ResponseKind, payload: unknown) => {
    sent.push({ via, payload });
    if (isRecord(payload) && Array.isArray(payload.components)) {
      lastComponents = payload.components;
    }
  };

  const message = {
    id: nextSnowflake(),
    channelId: channel.id,
    createdTimestamp: Date.now(),
    createMessageComponentCollector: vi.fn(() => {
      const collector = { on: vi.fn(() => collector), stop: vi.fn() };
      return collector;
    }),
    awaitMessageComponent: vi.fn(
      async (collectorOptions?: {
        filter?: (i: unknown) => boolean | Promise<boolean>;
      }) => {
        const customId = confirmButtonIn(lastComponents);
        if (!customId) {
          throw new Error(
            'Collector received no interactions before ending with reason: time'
          );
        }
        const press = {
          customId,
          componentType: ComponentType.Button,
          user: world.actor.user,
          member: world.actor,
          isButton: () => true,
          update: vi.fn(async (payload: unknown) => {
            record('component.update', payload);
          }),
          deferUpdate: vi.fn(async () => undefined),
          reply: vi.fn(async (payload: unknown) => {
            record('component.reply', payload);
          }),
        };
        if (
          collectorOptions?.filter &&
          !(await collectorOptions.filter(press))
        ) {
          throw new Error(
            'Collector received no interactions before ending with reason: time'
          );
        }
        return press;
      }
    ),
  };

  const respond = (payload: unknown) =>
    isRecord(payload) && payload.withResponse
      ? { resource: { type: 4, message } }
      : message;

  const acknowledge = (kind: ResponseKind) => {
    initialResponses.push(kind);
    if (state.replied || state.deferred) {
      violations.push(`${kind} after the interaction was already acknowledged`);
      throw new Error(
        'The reply to this interaction has already been sent or deferred.'
      );
    }
  };

  const requireAcknowledged = (kind: ResponseKind) => {
    if (!state.replied && !state.deferred) {
      violations.push(`${kind} before the interaction was acknowledged`);
      throw new Error(
        'The reply to this interaction has not been sent or deferred.'
      );
    }
  };

  const interaction = {
    id: nextSnowflake(),
    applicationId: IDS.bot,
    type: 2,
    commandId: nextSnowflake(),
    commandName: path.entry.json.name,
    commandType: 1,
    commandGuildId: null,
    user: world.actor.user,
    member: inGuild ? world.actor : null,
    // What Discord sends as the member's permissions in this channel.
    memberPermissions: inGuild ? world.actor.permissions : null,
    guild: inGuild ? world.guild : null,
    guildId: inGuild ? world.guild.id : null,
    channel,
    channelId: channel.id,
    locale: options.locale,
    guildLocale: inGuild ? 'en-US' : null,
    client: world.client,
    createdTimestamp: Date.now(),
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    options: resolver,
    inGuild: () => inGuild,
    inCachedGuild: () => inGuild,
    inRawGuild: () => false,
    isRepliable: () => true,
    isCommand: () => true,
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    toString: () => `/${path.label}`,
    reply: vi.fn(async (payload: unknown) => {
      maybeFail('reply');
      acknowledge('reply');
      state.replied = true;
      record('reply', payload);
      return respond(payload);
    }),
    deferReply: vi.fn(async (payload?: unknown) => {
      maybeFail('deferReply');
      acknowledge('deferReply');
      state.deferred = true;
      record('deferReply', payload ?? {});
      return respond(payload);
    }),
    showModal: vi.fn(async (payload: unknown) => {
      maybeFail('showModal');
      acknowledge('showModal');
      state.replied = true;
      record('showModal', payload);
      return respond(payload);
    }),
    editReply: vi.fn(async (payload: unknown) => {
      requireAcknowledged('editReply');
      maybeFail('editReply');
      record('editReply', payload);
      return message;
    }),
    followUp: vi.fn(async (payload: unknown) => {
      requireAcknowledged('followUp');
      record('followUp', payload);
      return { ...message, id: nextSnowflake() };
    }),
    deleteReply: vi.fn(async () => {
      requireAcknowledged('deleteReply');
      record('deleteReply', {});
    }),
    fetchReply: vi.fn(async () => {
      requireAcknowledged('editReply');
      return message;
    }),
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    initialResponses,
    violations,
    sent,
    optionReads,
    declaredOptions: new Set(path.options.map((option) => option.name)),
    injectedFailures,
  };
}

export interface AutocompleteInvocation {
  interaction: AutocompleteInteraction;
  respond: Mock;
}

/** An autocomplete interaction focused on `option` of `path`. */
export function autocompleteFor(
  world: SmokeWorld,
  path: CommandPath,
  option: LooseOption,
  focused: string
): AutocompleteInvocation {
  const reads = new Set<string>();
  const resolver = createResolver(
    world.client,
    nestUnderPath(path, [
      { name: option.name, type: option.type, value: focused, focused: true },
    ]),
    reads
  );
  const respond = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: nextSnowflake(),
    commandName: path.entry.json.name,
    user: world.actor.user,
    member: world.actor,
    guild: world.guild,
    guildId: world.guild.id,
    channel: world.textChannel,
    channelId: world.textChannel.id,
    locale: 'en-US',
    client: world.client,
    options: resolver,
    responded: false,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    respond,
  };
  return {
    interaction: interaction as unknown as AutocompleteInteraction,
    respond,
  };
}

// ---------------------------------------------------------------------------
// Reading what was sent
// ---------------------------------------------------------------------------

function toJSONIfBuilder(value: unknown): unknown {
  if (isRecord(value) && typeof value.toJSON === 'function') {
    return (value.toJSON as () => unknown)();
  }
  return value;
}

/** The embeds of a payload, serialised to their API shape. */
export function embedsOf(payload: unknown): APIEmbed[] {
  if (!isRecord(payload) || !Array.isArray(payload.embeds)) return [];
  return payload.embeds.map((embed) => toJSONIfBuilder(embed) as APIEmbed);
}

export interface LooseComponent {
  type: number;
  style?: number;
  custom_id?: string;
  label?: string;
  emoji?: unknown;
  placeholder?: string;
  url?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  components?: LooseComponent[];
}

/**
 * Serialise action rows. A builder that Discord would reject (a button
 * without a custom id, an empty select menu…) throws in `toJSON()`; that is
 * reported as a problem rather than thrown.
 */
function serializeRows(components: readonly unknown[]): {
  rows: Array<{ type: number; components: LooseComponent[] }>;
  problems: string[];
} {
  const rows: Array<{ type: number; components: LooseComponent[] }> = [];
  const problems: string[] = [];
  for (const row of components) {
    try {
      const json = toJSONIfBuilder(row) as {
        type: number;
        components?: LooseComponent[];
      };
      rows.push({ type: json.type, components: json.components ?? [] });
    } catch (error) {
      problems.push(
        `a component row does not serialise: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { rows, problems };
}

export function componentRowsOf(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.components)) {
    return { rows: [], problems: [] };
  }
  return serializeRows(payload.components);
}

/** Every user-visible string in a payload. */
export function textsOf(payload: unknown): string[] {
  if (typeof payload === 'string') return [payload];
  if (!isRecord(payload)) return [];

  const texts: string[] = [];
  if (typeof payload.content === 'string') texts.push(payload.content);

  for (const embed of embedsOf(payload)) {
    if (embed.title) texts.push(embed.title);
    if (embed.description) texts.push(embed.description);
    if (embed.footer?.text) texts.push(embed.footer.text);
    if (embed.author?.name) texts.push(embed.author.name);
    for (const field of embed.fields ?? []) {
      texts.push(field.name, field.value);
    }
  }

  for (const row of componentRowsOf(payload).rows) {
    for (const component of row.components) {
      if (component.label) texts.push(component.label);
      if (component.placeholder) texts.push(component.placeholder);
      for (const option of component.options ?? []) {
        texts.push(option.label);
        if (option.description) texts.push(option.description);
      }
    }
  }

  return texts;
}

/** Discord's documented message limits that a payload breaks. */
export function messageLimitProblems(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const problems: string[] = [];

  if (typeof payload.content === 'string' && payload.content.length > 2000) {
    problems.push(`content is ${payload.content.length} chars (max 2000)`);
  }

  const embeds = embedsOf(payload);
  if (embeds.length > 10) problems.push(`${embeds.length} embeds (max 10)`);
  let embedChars = 0;
  for (const embed of embeds) {
    const check = (label: string, text: string | undefined, max: number) => {
      if (text === undefined) return;
      embedChars += text.length;
      if (text.length > max) {
        problems.push(`embed ${label} is ${text.length} chars (max ${max})`);
      }
    };
    check('title', embed.title, 256);
    check('description', embed.description, 4096);
    check('footer', embed.footer?.text, 2048);
    check('author', embed.author?.name, 256);
    const fields = embed.fields ?? [];
    if (fields.length > 25) problems.push(`${fields.length} fields (max 25)`);
    for (const field of fields) {
      if (!field.name || !field.value) {
        problems.push(`embed field "${field.name}" has an empty name or value`);
      }
      check('field name', field.name, 256);
      check('field value', field.value, 1024);
    }
  }
  if (embedChars > 6000) {
    problems.push(`embeds total ${embedChars} chars (max 6000)`);
  }

  const { rows, problems: rowProblems } = componentRowsOf(payload);
  problems.push(...rowProblems);
  if (rows.length > 5) problems.push(`${rows.length} action rows (max 5)`);
  const customIds = new Set<string>();
  for (const row of rows) {
    if (row.components.length === 0 || row.components.length > 5) {
      problems.push(`an action row has ${row.components.length} components`);
    }
    for (const component of row.components) {
      if (component.type === ComponentType.Button) {
        const isLink = component.style === ButtonStyle.Link;
        if (isLink ? !component.url : component.custom_id === undefined) {
          problems.push(
            `button "${component.label ?? ''}" has no ${isLink ? 'url' : 'custom_id'}`
          );
        }
        if (!component.label && !component.emoji) {
          problems.push('a button has neither a label nor an emoji');
        }
      }
      if (component.custom_id !== undefined) {
        if (component.custom_id.length > 100) {
          problems.push(`custom_id "${component.custom_id}" exceeds 100 chars`);
        }
        if (customIds.has(component.custom_id)) {
          problems.push(`custom_id "${component.custom_id}" is used twice`);
        }
        customIds.add(component.custom_id);
      }
      if (component.label && component.label.length > 80) {
        problems.push(`button label "${component.label}" exceeds 80 chars`);
      }
      if (component.options) {
        if (component.options.length === 0 || component.options.length > 25) {
          problems.push(
            `select menu has ${component.options.length} options (1-25)`
          );
        }
        for (const option of component.options) {
          if (option.label.length > 100 || option.value.length > 100) {
            problems.push(`select option "${option.label}" exceeds 100 chars`);
          }
        }
      }
    }
  }

  if (isRecord(payload.poll)) {
    const poll = payload.poll as {
      question?: { text?: string };
      answers?: Array<{ text?: string }>;
      duration?: number;
    };
    const question = poll.question?.text ?? '';
    if (question.length === 0 || question.length > 300) {
      problems.push(`poll question is ${question.length} chars (1-300)`);
    }
    const answers = poll.answers ?? [];
    if (answers.length === 0 || answers.length > 10) {
      problems.push(`poll has ${answers.length} answers (1-10)`);
    }
    for (const answer of answers) {
      const text = answer.text ?? '';
      if (text.length === 0 || text.length > 55) {
        problems.push(`poll answer "${text}" is ${text.length} chars (1-55)`);
      }
    }
    if (
      poll.duration !== undefined &&
      (poll.duration < 1 || poll.duration > 768)
    ) {
      problems.push(`poll duration ${poll.duration}h (1-768)`);
    }
  }

  if (Array.isArray(payload.files) && payload.files.length > 10) {
    problems.push(`${payload.files.length} files (max 10)`);
  }

  return problems;
}

/**
 * Every prefix of every path (`voice`, `voice autojoin`,
 * `voice autojoin exclude`, …): what a `/…` reference in text may name.
 */
export function pathPrefixes(paths: readonly CommandPath[]): Set<string> {
  const prefixes = new Set<string>();
  for (const { label } of paths) {
    const tokens = label.split(' ');
    for (let i = 1; i <= tokens.length; i++) {
      prefixes.add(tokens.slice(0, i).join(' '));
    }
  }
  return prefixes;
}

/**
 * Slash command references in `text` that name no real command.
 *
 * Inside backticks a reference is read as a full path (`/voice record`,
 * stopping at option syntax such as `duration:30s` or a `{placeholder}`),
 * and every word of it must exist. Outside backticks only the command name
 * is checked, since the words after it may be ordinary prose.
 */
export function invalidSlashReferences(
  text: string,
  known: ReadonlySet<string>
): string[] {
  const invalid: string[] = [];

  for (const [, code] of text.matchAll(/`([^`]+)`/g)) {
    for (const part of code!.split(/,\s*/)) {
      const reference = /^\s*\/(.+)$/.exec(part)?.[1];
      if (!reference) continue;
      const tokens: string[] = [];
      for (const token of reference.split(/\s+/)) {
        if (!/^[a-z][\w-]*$/.test(token)) break;
        tokens.push(token);
      }
      if (tokens.length > 0 && !known.has(tokens.join(' '))) {
        invalid.push(`/${tokens.join(' ')}`);
      }
    }
  }

  const prose = text.replace(/`[^`]*`/g, ' ');
  for (const [, name] of prose.matchAll(/(?:^|[\s(（「:：])\/([a-z][\w-]*)/g)) {
    if (!known.has(name!)) invalid.push(`/${name}`);
  }

  return invalid;
}

/** Every leaf key of a translation dictionary, dot-separated. */
export function leafKeys(node: unknown, prefix = ''): string[] {
  if (!isRecord(node)) return [prefix];
  return Object.entries(node).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key)
  );
}

const TRANSLATION_KEYS = leafKeys(en);
const UNFILLED_PLACEHOLDER = /\{[A-Za-z]\w*\}/;
/**
 * A dotted key under one of the dictionary's namespaces, such as
 * `record.errors.removed`: what `t()` returns for a key that no longer
 * exists. Anchored to the real namespaces so prose like `example.com` is not
 * mistaken for one.
 */
const KEY_SHAPED = new RegExp(
  `(?:^|\\s)((?:${Object.keys(en).join('|')})(?:\\.[A-Za-z][A-Za-z0-9]*)+)(?=$|\\s)`
);

/**
 * Text that shows a translation went wrong: `t()` falls back to the key
 * itself for an unknown key and leaves `{name}` in place for a missing
 * parameter, and neither is something a user should ever see.
 */
export function translationProblems(texts: readonly string[]): string[] {
  const problems: string[] = [];
  for (const text of texts) {
    const key =
      TRANSLATION_KEYS.find((candidate) => text.includes(candidate)) ??
      KEY_SHAPED.exec(text)?.[1];
    if (key) problems.push(`raw translation key "${key}" in: ${text}`);
    if (UNFILLED_PLACEHOLDER.test(text)) {
      problems.push(`unfilled placeholder in: ${text}`);
    }
  }
  return problems;
}
