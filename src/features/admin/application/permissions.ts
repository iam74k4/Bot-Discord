import {
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type PermissionResolvable,
} from 'discord.js';
import { memberServerPermissions } from '../../../shared/utils/discord.js';

/**
 * Whether the invoking member holds `permission` server-wide (roles and
 * ownership; a channel overwrite does not count), judged the way the
 * permissions middleware judges it. `/admin` checks this itself because its
 * two groups need different permissions.
 */
export function memberHasServerPermission(
  interaction: ChatInputCommandInteraction,
  permission: PermissionResolvable
): boolean {
  if (!interaction.guild) return false;
  return memberServerPermissions(interaction)?.has(permission) ?? false;
}

/**
 * The bot's own server-wide permissions, or null when they cannot be read
 * (bot member not cached). Callers treat null as "let Discord decide" and
 * map its refusal instead of guessing.
 */
export function botServerPermissions(
  guild: Guild
): Readonly<PermissionsBitField> | null {
  const me = guild.members.me;
  if (!me) return null;
  try {
    const permissions = me.permissions;
    return permissions instanceof PermissionsBitField ? permissions : null;
  } catch {
    return null;
  }
}
