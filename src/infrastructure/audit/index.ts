import { Client, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { COLORS } from '../../shared/utils/constants/index.js';
import { logger } from '../../shared/utils/logger.js';
import { withRetry } from '../../shared/utils/retry.js';
import { t, type Locale, type TranslationKey } from '../../locales/index.js';
import { resolveBackgroundLocale } from '../../locales/guildLocale.js';
import { auditRepository, type AuditAction } from './auditRepository.js';
import { formatAuditTarget } from './format.js';

export { auditRepository } from './auditRepository.js';
export type { AuditAction, AuditLogRecord } from './auditRepository.js';
export { startAuditRetention, stopAuditRetention } from './retention.js';

const ACTION_COLORS: Record<AuditAction, number> = {
  NOTIFY_SETUP: COLORS.SUCCESS as number,
  NOTIFY_ENABLE: COLORS.SUCCESS as number,
  NOTIFY_DISABLE: COLORS.WARNING as number,
  NOTIFY_REMOVE: COLORS.ERROR as number,
  SETTINGS_CHANGE: COLORS.INFO as number,
  AUDIT_SETUP: COLORS.INFO as number,
  ROLE_ADD: COLORS.SUCCESS as number,
  ROLE_REMOVE: COLORS.WARNING as number,
};

/**
 * The language a guild's audit trail is written in: the embeds posted to its
 * audit channel and the details stored with each row. The audit channel is
 * read by the whole moderation team, so this follows the server
 * (`resolveBackgroundLocale`), not whoever happened to make the change. A
 * guild the bot no longer has cached still honours its configured language.
 */
export function auditLocaleOf(client: Client, guildId: string): Locale {
  return resolveBackgroundLocale(
    client.guilds.cache.get(guildId) ?? { id: guildId }
  );
}

/**
 * An action's name for people: `ロールを付与`, `Role Added`. A code this
 * version does not know (a row written by a newer one) is shown as itself.
 */
export function auditActionLabel(action: string, locale: Locale): string {
  const key = `audit.actions.${action}` as TranslationKey;
  const label = t(key, locale);
  return label === key ? action.replace(/_/g, ' ') : label;
}

/** `<@id>（name）`: the mention to click, with the name as it was then. */
function userWithName(id: string, name: string, locale: Locale): string {
  return t('audit.userWithName', locale, {
    mention: `<@${id}>`,
    name: escapeMarkdown(name),
  });
}

async function resolveAuditTargetDisplay(
  client: Client,
  action: AuditAction,
  targetId: string | undefined,
  locale: Locale
): Promise<string | null> {
  if (!targetId) return null;

  const target = formatAuditTarget(action, targetId);
  if (!target) return null;

  if (action === 'AUDIT_SETUP') return target;

  const targetUser = await client.users.fetch(targetId).catch(() => null);
  return targetUser ? userWithName(targetId, targetUser.tag, locale) : target;
}

export interface AuditLogOptions {
  /**
   * Post to this channel instead of the configured one (`null`: post
   * nowhere). Recording that the audit channel was just cleared is the case:
   * the channel that stops receiving logs gets the entry saying so.
   */
  deliverTo?: string | null;
}

export async function logAuditAction(
  client: Client,
  guildId: string,
  userId: string,
  action: AuditAction,
  targetId?: string,
  details?: string,
  options: AuditLogOptions = {}
): Promise<void> {
  // Callers fire this and move on, so a failed write must not surface as an
  // unhandled rejection and must never take down the action being audited.
  // The row is written before the first await: a caller that does not wait
  // still has it on record by the time it answers the user.
  let auditChannelId: string | null;
  try {
    auditRepository.createLog(guildId, userId, action, targetId, details);
    auditChannelId =
      options.deliverTo !== undefined
        ? options.deliverTo
        : auditRepository.getAuditChannel(guildId);
  } catch (error) {
    logger.error(
      `Failed to persist audit log (${action}) for guild ${guildId}:`,
      error
    );
    return;
  }

  if (!auditChannelId) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(auditChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) return;

    const locale = resolveBackgroundLocale(guild);
    const user = await client.users.fetch(userId).catch(() => null);
    const targetDisplay = await resolveAuditTargetDisplay(
      client,
      action,
      targetId,
      locale
    );

    const embed = new EmbedBuilder()
      .setTitle(auditActionLabel(action, locale))
      .setColor(ACTION_COLORS[action])
      .addFields({
        name: t('audit.fields.user', locale),
        value: user ? userWithName(userId, user.tag, locale) : `<@${userId}>`,
        inline: true,
      })
      .setTimestamp();

    if (targetDisplay) {
      embed.addFields({
        name: t('audit.fields.target', locale),
        value: targetDisplay,
        inline: true,
      });
    }

    if (details) {
      embed.addFields({
        name: t('audit.fields.details', locale),
        value: details,
        inline: false,
      });
    }

    await withRetry(() => channel.send({ embeds: [embed] }), {
      maxRetries: 2,
      operationName: 'audit channel.send',
    });
  } catch (error) {
    logger.error('Failed to send audit log:', error);
  }
}

/** A notification kind in the audit trail's language (`Voice` → `VC入退室`). */
function notificationKindLabel(kind: string, locale: Locale): string {
  const key = `audit.kinds.${kind}` as TranslationKey;
  const label = t(key, locale);
  return label === key ? kind : label;
}

export const audit = {
  notifySetup: (
    client: Client,
    guildId: string,
    userId: string,
    channelId: string,
    kind?: string
  ) => {
    const locale = auditLocaleOf(client, guildId);
    return logAuditAction(
      client,
      guildId,
      userId,
      'NOTIFY_SETUP',
      undefined,
      kind
        ? t('audit.details.notifySetup', locale, {
            kind: notificationKindLabel(kind, locale),
            channel: channelId,
          })
        : t('audit.details.notifyChannel', locale, { channel: channelId })
    );
  },

  notifyEnable: (client: Client, guildId: string, userId: string) =>
    logAuditAction(client, guildId, userId, 'NOTIFY_ENABLE'),

  notifyDisable: (client: Client, guildId: string, userId: string) =>
    logAuditAction(client, guildId, userId, 'NOTIFY_DISABLE'),

  notifyRemove: (
    client: Client,
    guildId: string,
    userId: string,
    kind?: string
  ) => {
    const locale = auditLocaleOf(client, guildId);
    return logAuditAction(
      client,
      guildId,
      userId,
      'NOTIFY_REMOVE',
      undefined,
      kind
        ? t('audit.details.notifyRemove', locale, {
            kind: notificationKindLabel(kind, locale),
          })
        : undefined
    );
  },

  roleAdd: (
    client: Client,
    guildId: string,
    userId: string,
    targetId: string,
    details: string
  ) => logAuditAction(client, guildId, userId, 'ROLE_ADD', targetId, details),

  roleRemove: (
    client: Client,
    guildId: string,
    userId: string,
    targetId: string,
    details: string
  ) =>
    logAuditAction(client, guildId, userId, 'ROLE_REMOVE', targetId, details),

  settingsChange: (
    client: Client,
    guildId: string,
    userId: string,
    details: string
  ) =>
    logAuditAction(
      client,
      guildId,
      userId,
      'SETTINGS_CHANGE',
      undefined,
      details
    ),
};
