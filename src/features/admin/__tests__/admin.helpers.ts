import type { Database } from 'better-sqlite3';
import {
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
  type APIEmbed,
  type Client,
  type Guild,
  type MessageComponentInteraction,
} from 'discord.js';
import { vi, type Mock } from 'vitest';

/**
 * Shared doubles for the admin feature's tests.
 *
 * Admin code is glue between `guild_settings` / `audit_logs`, the shared
 * `getSendableTextChannel` / `runComponentPanel` helpers and the reply surface
 * of an interaction. The tables run on real in-memory SQLite (each test file
 * mocks the connection), and the Discord side is faked here just far enough
 * for the real shared helpers to run against it.
 */

export const GUILD_ID = 'guild-1';
export const USER_ID = 'user-1';

/**
 * Bring an in-memory database up to the schema admin reads, using the real
 * migrations. Must be called after the test file has mocked the database
 * connection to point at that database.
 */
export async function migrateAdminSchema(): Promise<void> {
  const migrations = [
    // guild_settings + audit_logs
    await import('../../../infrastructure/database/migrations/003_settings.js'),
    // notification_channels + voice_sessions (counted by the DB stats view)
    await import('../../../infrastructure/database/migrations/004_notification.js'),
    await import('../../../infrastructure/database/migrations/007_voice_autojoin.js'),
    await import('../../../infrastructure/database/migrations/008_announcement_channel.js'),
  ];
  for (const migration of migrations) {
    migration.up();
  }
}

/** Empty every table the admin tests write to. */
export function clearAdminTables(db: Database): void {
  for (const table of [
    'guild_settings',
    'audit_logs',
    'notification_channels',
    'voice_sessions',
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
}

export interface AuditRow {
  action: string;
  user_id: string;
  target_id: string | null;
  details: string | null;
}

/** Audit rows persisted for a guild, oldest first. */
export function auditRows(db: Database, guildId = GUILD_ID): AuditRow[] {
  return db
    .prepare(
      'SELECT action, user_id, target_id, details FROM audit_logs WHERE guild_id = ? ORDER BY id'
    )
    .all(guildId) as AuditRow[];
}

/** The stored settings row for a guild, or undefined when none exists. */
export function settingsRow(
  db: Database,
  guildId = GUILD_ID
):
  | {
      language: string | null;
      audit_channel_id: string | null;
      announcement_channel_id: string | null;
    }
  | undefined {
  return db
    .prepare(
      'SELECT language, audit_channel_id, announcement_channel_id FROM guild_settings WHERE guild_id = ?'
    )
    .get(guildId) as
    | {
        language: string | null;
        audit_channel_id: string | null;
        announcement_channel_id: string | null;
      }
    | undefined;
}

/**
 * Insert `count` audit rows whose `created_at` increases with the index, so
 * row `count - 1` is the newest and comes first in `getLogs`.
 */
export function insertAuditLogs(
  db: Database,
  count: number,
  options: {
    guildId?: string;
    action?: string;
    targetId?: string | null;
    baseTime?: number;
  } = {}
): void {
  const stmt = db.prepare(
    `INSERT INTO audit_logs (guild_id, user_id, action, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < count; i++) {
    stmt.run(
      options.guildId ?? GUILD_ID,
      `actor-${i}`,
      options.action ?? 'SETTINGS_CHANGE',
      options.targetId ?? null,
      null,
      (options.baseTime ?? 1_700_000_000_000) + i * 1000
    );
  }
}

/** A minimal client: no cached guilds, so audit logging only persists. */
export function clientStub(guilds: Guild[] = []): Client {
  return {
    guilds: {
      cache: new Collection(guilds.map((guild) => [guild.id, guild])),
    },
    channels: { cache: new Collection() },
    users: { fetch: vi.fn().mockResolvedValue(null) },
  } as unknown as Client;
}

/**
 * A real `TextChannel` prototype so `instanceof` checks in
 * `getSendableTextChannel` pass. `canSend` controls the bot's SendMessages.
 */
export function textChannelStub(options: {
  id: string;
  name?: string;
  canSend?: boolean;
  send?: Mock;
}): TextChannel & { send: Mock } {
  const channel = {
    id: options.id,
    name: options.name ?? `chan-${options.id}`,
    permissionsFor: vi.fn(
      () =>
        new PermissionsBitField(
          options.canSend === false ? [] : [PermissionFlagsBits.SendMessages]
        )
    ),
    send: options.send ?? vi.fn().mockResolvedValue({}),
  };
  Object.setPrototypeOf(channel, TextChannel.prototype);
  return channel as unknown as TextChannel & { send: Mock };
}

/**
 * A guild with the given channels cached. Uncached channels fail to fetch
 * (as Discord does for deleted ones), and the bot member is present unless
 * `withBot` is false.
 */
export function guildStub(
  options: {
    id?: string;
    name?: string;
    memberCount?: number;
    channels?: TextChannel[];
    withBot?: boolean;
  } = {}
): Guild {
  return {
    id: options.id ?? GUILD_ID,
    name: options.name ?? 'Test Guild',
    memberCount: options.memberCount ?? 0,
    channels: {
      cache: new Collection(
        (options.channels ?? []).map((channel) => [channel.id, channel])
      ),
      fetch: vi.fn().mockRejectedValue(new Error('Unknown Channel')),
    },
    members: {
      me: options.withBot === false ? null : { id: 'bot-member' },
    },
  } as unknown as Guild;
}

type CollectHandler = (interaction: MessageComponentInteraction) => unknown;
type EndHandler = () => unknown;

/**
 * Stand-in for the reply → message → collector chain `runComponentPanel`
 * walks. `collect`/`end` invoke the registered handlers and wait for them,
 * which a plain EventEmitter would not do for async listeners.
 */
export interface PanelHarness {
  reply: Mock;
  editReply: Mock;
  message: { createMessageComponentCollector: Mock };
  collect(interaction: MessageComponentInteraction): Promise<void>;
  end(): Promise<void>;
}

export function createPanelHarness(): PanelHarness {
  const handlers: { collect?: CollectHandler; end?: EndHandler } = {};
  const collector = {
    on: vi.fn((event: 'collect' | 'end', handler: CollectHandler) => {
      handlers[event] = handler as never;
      return collector;
    }),
  };
  const message = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  const reply = vi.fn().mockResolvedValue({ resource: { message } });
  const editReply = vi.fn().mockResolvedValue({});

  return {
    reply,
    editReply,
    message,
    async collect(interaction: MessageComponentInteraction): Promise<void> {
      if (!handlers.collect) throw new Error('panel registered no collector');
      await handlers.collect(interaction);
    },
    async end(): Promise<void> {
      if (!handlers.end) throw new Error('panel registered no end handler');
      await handlers.end();
    },
  };
}

export type ComponentKind = 'button' | 'string' | 'channel';

export interface ComponentStub {
  customId: string;
  values: string[];
  user: { id: string };
  client: Client;
  guildId: string;
  isButton: () => boolean;
  isStringSelectMenu: () => boolean;
  isChannelSelectMenu: () => boolean;
  update: Mock;
  reply: Mock;
  deferUpdate: Mock;
}

/** A component interaction of the given kind, pressed by `USER_ID`. */
export function componentStub(
  kind: ComponentKind,
  customId: string,
  options: { values?: string[]; userId?: string; client?: Client } = {}
): ComponentStub & MessageComponentInteraction {
  const stub: ComponentStub = {
    customId,
    values: options.values ?? [],
    user: { id: options.userId ?? USER_ID },
    client: options.client ?? clientStub(),
    guildId: GUILD_ID,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'string',
    isChannelSelectMenu: () => kind === 'channel',
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  };
  return stub as ComponentStub & MessageComponentInteraction;
}

/** The serialised embed at `index` of a reply/update payload. */
export function embedAt(
  payload: { embeds?: unknown[] } | undefined,
  index = 0
): APIEmbed {
  const embed = payload?.embeds?.[index] as { toJSON(): APIEmbed } | undefined;
  if (!embed) throw new Error(`no embed at index ${index}`);
  return embed.toJSON();
}

export interface SerialisedComponent {
  type: number;
  custom_id?: string;
  label?: string;
  style?: number;
  disabled?: boolean;
  placeholder?: string;
  channel_types?: number[];
  options?: Array<{ label: string; value: string; default?: boolean }>;
}

/** Each action row of a payload, serialised to its API components. */
export function rowsOf(
  components: readonly unknown[] | undefined
): SerialisedComponent[][] {
  return (components ?? []).map(
    (row) =>
      (row as { toJSON(): { components: SerialisedComponent[] } }).toJSON()
        .components
  );
}

/** The first argument of the `call`-th invocation of a mock. */
export function payloadOf<T = Record<string, unknown>>(
  mock: Mock,
  call = 0
): T {
  const args = mock.mock.calls[call];
  if (!args) throw new Error(`mock was not called ${call + 1} time(s)`);
  return args[0] as T;
}
