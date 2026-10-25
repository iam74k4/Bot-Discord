import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  PermissionResolvable,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';
import { createWarningEmbed } from './embed.js';
import { t, type Locale, type TranslationKey } from '../../locales/index.js';
import { formatList } from '../../locales/format.js';

function extractPermissions(value: unknown): PermissionsBitField | null {
  if (
    value &&
    typeof value === 'object' &&
    'permissions' in value &&
    value.permissions instanceof PermissionsBitField
  ) {
    return value.permissions;
  }

  if (value instanceof PermissionsBitField) {
    return value;
  }

  return null;
}

export function hasPermission(
  value: unknown,
  permission: PermissionResolvable
): boolean {
  const permissions = extractPermissions(value);
  return permissions?.has(permission) ?? false;
}

export function interactionHasGuildPermission(
  interaction: ChatInputCommandInteraction,
  permission: PermissionResolvable
): boolean {
  if (!interaction.guild || !interaction.member) return false;
  return hasPermission(interaction.member, permission);
}

/**
 * The permissions a command's server-wide requirements are checked against
 * (server settings, role management).
 *
 * A cached member is judged on their server-wide permissions - roles and
 * ownership - so a channel overwrite cannot grant them: the "Manage
 * Permissions" overwrite is the very bit Manage Roles uses, and the
 * permissions Discord attaches to an interaction include the channel's
 * overwrites. Those are only the fallback for an uncached member, which is
 * the same answer for server-only permissions such as Manage Server. The
 * member object's own field is the last fallback, for partial stand-ins.
 */
export function memberServerPermissions(interaction: {
  member: unknown;
  memberPermissions?: unknown;
}): Readonly<PermissionsBitField> | null {
  if (interaction.member instanceof GuildMember) {
    try {
      return interaction.member.permissions;
    } catch {
      // Roles not cached: fall through to what Discord sent.
    }
  }
  if (interaction.memberPermissions instanceof PermissionsBitField) {
    return interaction.memberPermissions;
  }
  const member = interaction.member as { permissions?: unknown } | null;
  return member?.permissions instanceof PermissionsBitField
    ? member.permissions
    : null;
}

/**
 * What the bot needs in a text channel to post an embed there - every
 * notification, audit entry and announcement is one. Send Messages alone is
 * not enough, and Discord reports Send Messages as granted in a channel the
 * bot cannot even see, so View Channel is checked explicitly.
 */
export const POST_EMBED_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
] as const;

export type PostableChannelCheck =
  | { ok: true; channel: TextChannel }
  /** Not a text channel, deleted, or the bot member is not cached. */
  | { ok: false; reason: 'unavailable' }
  | {
      ok: false;
      reason: 'missingPermissions';
      channel: TextChannel;
      missing: bigint[];
    };

/**
 * Whether the bot can post embeds in a text channel, and if not, why: setup
 * commands use the reason to name the missing permission instead of saving
 * a channel every later post would fail in.
 */
export async function checkPostableTextChannel(
  guild: Guild,
  channelId: string
): Promise<PostableChannelCheck> {
  const channel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!(channel instanceof TextChannel)) {
    return { ok: false, reason: 'unavailable' };
  }

  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'unavailable' };

  const granted = channel.permissionsFor(me) ?? new PermissionsBitField();
  const missing = POST_EMBED_PERMISSIONS.filter(
    (permission) => !granted.has(permission)
  );
  if (missing.length === 0) return { ok: true, channel };

  return { ok: false, reason: 'missingPermissions', channel, missing };
}

/**
 * A text channel the bot can post embeds in, or null - for background posts
 * (notifications), which skip a channel they could only fail in.
 */
export async function getSendableTextChannel(
  guild: Guild,
  channelId: string
): Promise<TextChannel | null> {
  const check = await checkPostableTextChannel(guild, channelId);
  return check.ok ? check.channel : null;
}

/**
 * Permission names as Discord's own client shows them to this reader
 * (`サーバー管理`, `Manage Server`), never the raw flag (`ManageGuild`).
 * A flag without a translation falls back to its flag name.
 */
export function permissionNames(
  permissions: PermissionResolvable | readonly PermissionResolvable[],
  locale: Locale
): string[] {
  const list = (
    Array.isArray(permissions) ? permissions : [permissions]
  ) as PermissionResolvable[];
  const flags = new PermissionsBitField(list).toArray();

  return flags.map((flag) => {
    const key = `common.permissionNames.${flag}` as TranslationKey;
    const label = t(key, locale);
    return label === key ? flag : label;
  });
}

/**
 * Permission names joined for a sentence: `「サーバー管理」、「ロールの管理」`
 * in Japanese, `Manage Server and Manage Roles` in English. Use it for the
 * `{permissions}` parameter of `common.permissionsRequired`.
 */
export function formatPermissionNames(
  permissions: PermissionResolvable | readonly PermissionResolvable[],
  locale: Locale
): string {
  const names = permissionNames(permissions, locale);
  return formatList(
    locale === 'ja' ? names.map((name) => `「${name}」`) : names,
    locale
  );
}

/**
 * The one way a missing permission is reported: a warning (the user did
 * nothing wrong), titled "Missing permission", naming the permission the way
 * Discord's client does and pointing at a server admin.
 */
export function createPermissionDeniedEmbed(
  permissions: PermissionResolvable | readonly PermissionResolvable[],
  locale: Locale
): EmbedBuilder {
  return createWarningEmbed(
    t('common.permissionDeniedTitle', locale),
    t('common.permissionsRequired', locale, {
      permissions: formatPermissionNames(permissions, locale),
    })
  );
}
