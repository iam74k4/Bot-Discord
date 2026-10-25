import {
  ChatInputCommandInteraction,
  type PermissionResolvable,
} from 'discord.js';
import { Command } from '../shared/types/index.js';
import { t } from '../locales/index.js';
import { resolveLocale } from '../locales/guildLocale.js';
import {
  formatPermissionNames,
  memberServerPermissions,
} from '../shared/utils/discord.js';
import type { MiddlewareOutcome } from './types.js';

/**
 * Check if user has required permissions
 */
export async function permissionsMiddleware(
  interaction: ChatInputCommandInteraction,
  command: Command
): Promise<MiddlewareOutcome> {
  const requiredPermissions = command.options?.permissions;

  if (!requiredPermissions || requiredPermissions.length === 0) {
    return { success: true };
  }

  const locale = resolveLocale(interaction);

  if (!interaction.guild || !interaction.member) {
    return {
      success: false,
      title: t('common.serverOnlyTitle', locale),
      message: t('common.guildOnly', locale),
    };
  }

  // Server-wide permissions: a channel overwrite cannot grant these.
  const memberPermissions = memberServerPermissions(interaction);

  if (!memberPermissions) {
    return {
      success: false,
      title: t('common.permissionDeniedTitle', locale),
      message: t('common.permissionsUnverifiable', locale),
    };
  }

  const missing: PermissionResolvable[] = requiredPermissions.filter(
    (permission) => !memberPermissions.has(permission)
  );

  if (missing.length > 0) {
    return {
      success: false,
      title: t('common.permissionDeniedTitle', locale),
      message: t('common.permissionsRequired', locale, {
        permissions: formatPermissionNames(missing, locale),
      }),
    };
  }

  return { success: true };
}
