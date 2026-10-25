import type { Guild } from 'discord.js';
import { t, type Locale } from '../../../locales/index.js';
import {
  checkPostableTextChannel,
  formatPermissionNames,
  type PostableChannelCheck,
} from '../../../shared/utils/discord.js';

/**
 * Check a channel before saving it as (or posting to) an admin channel -
 * audit log entries and owner announcements are embeds - so setup fails
 * naming the missing permission instead of succeeding and then failing on
 * every post.
 */
export function checkPostableChannel(
  guild: Guild,
  channelId: string
): Promise<PostableChannelCheck> {
  return checkPostableTextChannel(guild, channelId);
}

/** What to tell an admin whose channel failed `checkPostableChannel`. */
export function describeChannelProblem(
  check: Exclude<PostableChannelCheck, { ok: true }>,
  locale: Locale
): string {
  if (check.reason === 'unavailable') {
    return t('settings.errors.channelNotSendable', locale);
  }
  return t('settings.errors.channelMissingPermissions', locale, {
    channel: check.channel.id,
    permissions: formatPermissionNames(check.missing, locale),
  });
}
