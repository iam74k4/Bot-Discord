import type { Database } from 'better-sqlite3';
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  type APIEmbed,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  type MessageComponentInteraction,
} from 'discord.js';
import { vi, type Mock } from 'vitest';

/**
 * Shared doubles for the notification feature's tests.
 *
 * The notification code is mostly glue between three things: the
 * `notification_channels` / `voice_daily_stats` tables, `getSendableTextChannel`
 * and the reply/collector surface of an interaction. The tables run on real
 * in-memory SQLite (each test file mocks the connection), and the Discord side
 * is faked here just far enough for the real shared helpers to run against it.
 */

export const GUILD_ID = 'guild-1';
export const USER_ID = 'user-1';
export const BOT_MEMBER = { id: 'bot-member' };

/**
 * Bring an in-memory database up to the schema the notification feature reads,
 * using the real migrations. Must be called after the test file has mocked the
 * database connection to point at that database.
 */
export async function migrateNotificationSchema(): Promise<void> {
  const migrations = [
    // guild_settings: locale resolution reads the guild's language from here.
    await import('../../../infrastructure/database/migrations/003_settings.js'),
    await import('../../../infrastructure/database/migrations/004_notification.js'),
    await import('../../../infrastructure/database/migrations/007_voice_autojoin.js'),
    await import('../../../infrastructure/database/migrations/008_announcement_channel.js'),
    await import('../../../infrastructure/database/migrations/009_voice_daily_stats.js'),
  ];
  for (const migration of migrations) {
    migration.up();
  }
}

/** Empty every table the notification tests write to. */
export function clearNotificationTables(db: Database): void {
  for (const table of [
    'guild_settings',
    'notification_channels',
    'voice_sessions',
    'voice_daily_stats',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

/** Insert one rollup row the stats panel will read. */
export function insertDailyStat(
  db: Database,
  row: {
    day: string;
    durationMs: number;
    channelId?: string;
    channelName?: string;
    userId?: string;
    guildId?: string;
    sessions?: number;
  }
): void {
  db.prepare(
    `INSERT INTO voice_daily_stats
       (guild_id, user_id, channel_id, channel_name, day,
        total_duration_ms, session_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    row.guildId ?? GUILD_ID,
    row.userId ?? USER_ID,
    row.channelId ?? 'vc-1',
    row.channelName ?? 'General',
    row.day,
    row.durationMs,
    row.sessions ?? 1
  );
}

/**
 * A text channel that passes the real `getSendableTextChannel` checks
 * (`instanceof TextChannel` plus a SendMessages permission for the bot).
 */
export function createTextChannel(
  id: string,
  options: { canSend?: boolean } = {}
): TextChannel {
  const channel = Object.create(TextChannel.prototype) as TextChannel;
  Object.defineProperties(channel, {
    id: { value: id },
    type: { value: ChannelType.GuildText },
    send: { value: vi.fn().mockResolvedValue({}) },
    permissionsFor: {
      value: vi.fn(
        () =>
          new PermissionsBitField(
            options.canSend === false ? 0n : PermissionFlagsBits.SendMessages
          )
      ),
    },
  });
  return channel;
}

export interface FakeGuildOptions {
  id?: string;
  /** Channels already in the guild's channel cache. */
  cached?: TextChannel[];
  /** Channels only reachable through `guild.channels.fetch`. */
  fetchable?: TextChannel[];
  /** The bot's own member; `null` models a guild where it is not cached. */
  me?: object | null;
  preferredLocale?: string;
  memberCount?: number;
}

export function createGuild(options: FakeGuildOptions = {}): Guild {
  const cache = new Collection<string, TextChannel>(
    (options.cached ?? []).map((channel) => [channel.id, channel])
  );
  const fetchable = options.fetchable ?? [];

  return {
    id: options.id ?? GUILD_ID,
    preferredLocale: options.preferredLocale ?? 'en-US',
    memberCount: options.memberCount ?? 10,
    channels: {
      cache,
      fetch: vi.fn(async (channelId: string) => {
        const found = fetchable.find((channel) => channel.id === channelId);
        if (!found) throw new Error('Unknown Channel');
        return found;
      }),
    },
    members: {
      me: options.me === undefined ? BOT_MEMBER : options.me,
    },
  } as unknown as Guild;
}

export interface FakeCommandOptions {
  /** `null` models a DM; omitted gives a guild with no channels. */
  guild?: Guild | null;
  locale?: string;
  /** Whether the invoking member holds Manage Server. Defaults to false. */
  manageGuild?: boolean;
  subcommandGroup?: string | null;
  subcommand?: string;
  channel?: { id: string; type: ChannelType } | null;
  period?: string | null;
  userId?: string;
}

type CollectorHandler = (...args: unknown[]) => Promise<void>;

export interface FakeCommand {
  interaction: ChatInputCommandInteraction;
  reply: Mock;
  editReply: Mock;
  createMessageComponentCollector: Mock;
  /** Deliver a component interaction to the panel's collector. */
  collect: (component: MessageComponentInteraction) => Promise<void>;
  /** Fire the collector's `end` event (the panel timing out). */
  end: () => Promise<void>;
}

/**
 * A slash command interaction whose reply hands back a message with a fake
 * component collector, so panels built on `runComponentPanel` can be driven
 * button by button.
 */
export function createCommandInteraction(
  options: FakeCommandOptions = {}
): FakeCommand {
  const handlers: Record<string, CollectorHandler> = {};
  const createMessageComponentCollector = vi.fn(() => {
    const collector = {
      on(event: string, handler: CollectorHandler) {
        handlers[event] = handler;
        return collector;
      },
    };
    return collector;
  });

  const guild = options.guild === undefined ? createGuild() : options.guild;
  const reply = vi.fn().mockResolvedValue({
    resource: { message: { createMessageComponentCollector } },
  });
  const editReply = vi.fn().mockResolvedValue({});

  const interaction = {
    guild,
    guildId: guild?.id ?? null,
    locale: options.locale ?? 'en-US',
    user: { id: options.userId ?? USER_ID },
    member: guild
      ? {
          permissions: new PermissionsBitField(
            options.manageGuild ? PermissionFlagsBits.ManageGuild : 0n
          ),
        }
      : null,
    client: { id: 'client-1' },
    options: {
      getSubcommandGroup: vi.fn(() => options.subcommandGroup ?? null),
      getSubcommand: vi.fn(() => options.subcommand ?? ''),
      getChannel: vi.fn(() => options.channel ?? null),
      getString: vi.fn((name: string) =>
        name === 'period' ? (options.period ?? null) : null
      ),
    },
    reply,
    editReply,
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    reply,
    editReply,
    createMessageComponentCollector,
    collect: async (component) => {
      if (!handlers.collect) throw new Error('panel registered no collector');
      await handlers.collect(component);
    },
    end: async () => {
      if (!handlers.end) throw new Error('panel registered no collector');
      await handlers.end();
    },
  };
}

export type ComponentKind = 'button' | 'stringSelect' | 'channelSelect';

export interface FakeComponent {
  interaction: MessageComponentInteraction;
  update: Mock;
  reply: Mock;
  deferUpdate: Mock;
}

export function createComponentInteraction(
  kind: ComponentKind,
  customId: string,
  options: { values?: string[]; userId?: string } = {}
): FakeComponent {
  const update = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferUpdate = vi.fn().mockResolvedValue(undefined);

  const interaction = {
    customId,
    values: options.values ?? [],
    user: { id: options.userId ?? USER_ID },
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'stringSelect',
    isChannelSelectMenu: () => kind === 'channelSelect',
    update,
    reply,
    deferUpdate,
  } as unknown as MessageComponentInteraction;

  return { interaction, update, reply, deferUpdate };
}

/** Plain JSON of the first embed in a reply/update payload. */
export function embedOf(payload: unknown): APIEmbed {
  const embeds = (payload as { embeds: EmbedBuilder[] }).embeds;
  return embeds[0].toJSON();
}

export interface ComponentJson {
  type: number;
  custom_id?: string;
  label?: string;
  style?: number;
  disabled?: boolean;
  placeholder?: string;
  channel_types?: number[];
  options?: Array<{ value: string; label: string; default?: boolean }>;
}

/** Plain JSON of every action row in a payload's `components`. */
export function rowsOf(payload: unknown): ComponentJson[][] {
  const rows = (payload as { components: Array<{ toJSON(): unknown }> })
    .components;
  return rows.map(
    (row) => (row.toJSON() as { components: ComponentJson[] }).components
  );
}

/** Every custom id in a payload, row by row, for asserting layout. */
export function customIdsOf(payload: unknown): string[][] {
  return rowsOf(payload).map((row) => row.map((c) => c.custom_id ?? ''));
}

/** Last argument object a mock was called with. */
export function lastCallArg(mock: Mock): unknown {
  const calls = mock.mock.calls;
  if (calls.length === 0) throw new Error('mock was never called');
  return calls[calls.length - 1][0];
}
