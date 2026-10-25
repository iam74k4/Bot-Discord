import type { Guild, TextChannel } from 'discord.js';
import { t, type Locale } from '../../../locales/index.js';
import {
  checkPostableTextChannel,
  formatPermissionNames,
} from '../../../shared/utils/discord.js';

export type NotificationChannelCheck =
  | { ok: true; channel: TextChannel }
  | { ok: false; message: string };

/**
 * Check a channel picked as a notification target before saving it, so setup
 * fails with the missing permission named instead of succeeding and then
 * failing silently on every post (notifications are embeds: View Channel,
 * Send Messages and Embed Links).
 */
export async function checkNotificationChannel(
  guild: Guild,
  channelId: string,
  locale: Locale
): Promise<NotificationChannelCheck> {
  const check = await checkPostableTextChannel(guild, channelId);
  if (check.ok) return check;
  if (check.reason === 'unavailable') {
    return {
      ok: false,
      message: t('notification.errors.channelNotSendable', locale),
    };
  }
  return {
    ok: false,
    message: t('notification.errors.channelMissingPermissions', locale, {
      channel: check.channel.id,
      permissions: formatPermissionNames(check.missing, locale),
    }),
  };
}
