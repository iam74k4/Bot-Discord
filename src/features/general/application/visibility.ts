import { PermissionsBitField } from 'discord.js';
import { t, type Locale } from '../../../locales/index.js';
import type {
  CommandInfo,
  PermissionLevel,
} from '../../../shared/help/catalog.js';
import { isBotOwner } from '../../../config/env.js';

/**
 * Who may see a help entry. Help only lists what the asker can run, so the
 * same check decides the overview, the detail page, autocomplete and the
 * commands `/general about` points at.
 */

export interface PermissionContext {
  userId: string;
  guild: { id: string } | null;
  member: { permissions: PermissionsBitField } | null;
}

export function getPermissionContext(interaction: {
  user: { id: string };
  guild: { id: string } | null;
  member: unknown;
}): PermissionContext {
  return {
    userId: interaction.user.id,
    guild: interaction.guild,
    member: interaction.member as { permissions: PermissionsBitField } | null,
  };
}

const GUILD_PERMISSION_BITS: Partial<Record<PermissionLevel, bigint>> = {
  manageGuild: PermissionsBitField.Flags.ManageGuild,
  manageRoles: PermissionsBitField.Flags.ManageRoles,
  administrator: PermissionsBitField.Flags.Administrator,
};

export function canUserSeeCommandWithContext(
  cmd: CommandInfo,
  ctx: PermissionContext
): boolean {
  const perm = cmd.requiredPermission;
  if (!perm || perm === 'everyone') return true;

  const levels = Array.isArray(perm) ? perm : [perm];

  for (const level of levels) {
    if (level === 'everyone') return true;
    if (level === 'owner') {
      if (isBotOwner(ctx.userId)) return true;
      continue;
    }

    const bit = GUILD_PERMISSION_BITS[level];
    if (bit === undefined || !ctx.guild || !ctx.member) continue;
    // A raw API member carries its permissions as a string; only a resolved
    // bitfield is trusted.
    const memberPerms = ctx.member.permissions;
    if (!(memberPerms instanceof PermissionsBitField)) continue;
    if (memberPerms.has(bit)) return true;
  }
  return false;
}

/** Localized labels of the levels an entry needs, `everyone` left out. */
export function permissionLabels(cmd: CommandInfo, locale: Locale): string[] {
  const perm = cmd.requiredPermission;
  if (!perm || perm === 'everyone') return [];
  const levels = Array.isArray(perm) ? perm : [perm];
  return levels
    .filter((level) => level !== 'everyone')
    .map((level) => t(`help.permission.${level}`, locale));
}

/** ` [Manage Server, Manage Roles]` after a list line, or ''. */
export function formatCommandPermissionLabel(
  cmd: CommandInfo,
  locale: Locale
): string {
  const labels = permissionLabels(cmd, locale);
  return labels.length > 0 ? ` [${labels.join(', ')}]` : '';
}

/** `サーバー管理またはロールの管理` / `Manage Server or Manage Roles`, or ''. */
export function formatPermissionAlternatives(
  cmd: CommandInfo,
  locale: Locale
): string {
  const labels = permissionLabels(cmd, locale);
  if (labels.length === 0) return '';
  return new Intl.ListFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    style: 'long',
    type: 'disjunction',
  }).format(labels);
}
