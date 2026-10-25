import type { Client, Guild } from 'discord.js';
import { guildSettingsRepository } from '../../../infrastructure/guildSettings/index.js';
import {
  logAuditAction,
  type AuditAction,
} from '../../../infrastructure/audit/index.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';

/**
 * The guild settings that point at a text channel: where audit logs go and
 * where owner announcements are received. The slash commands and the
 * settings panel both change them through `saveChannelSetting`, so either
 * way the change is stored and put on record the same way.
 */
export interface ChannelSetting {
  read: (guildId: string) => string | null;
  store: (guildId: string, channelId: string | null) => void;
  action: AuditAction;
  /**
   * The audit row's target. The audit channel is AUDIT_SETUP's target (shown
   * as a channel); an announcement channel goes in the details instead,
   * because a SETTINGS_CHANGE target is read as a member.
   */
  auditTarget: (channelId: string) => string | undefined;
  /**
   * The audit row's details. A channel already shown as the target is not
   * repeated here, or the log line and audit embed would name it twice.
   */
  detail: (locale: Locale, channelId: string | null) => string | undefined;
  /**
   * Whether the entry recording a clear still goes to the channel that was
   * just cleared, so the audit channel itself says it was switched off.
   */
  deliverClearToPrevious: boolean;
}

export const AUDIT_CHANNEL_SETTING: ChannelSetting = {
  read: (guildId) => guildSettingsRepository.getAuditChannel(guildId),
  store: (guildId, channelId) =>
    guildSettingsRepository.setAuditChannel(guildId, channelId),
  action: 'AUDIT_SETUP',
  auditTarget: (channelId) => channelId,
  detail: (locale, channelId) =>
    channelId ? undefined : t('audit.details.auditChannelCleared', locale),
  deliverClearToPrevious: true,
};

export const ANNOUNCEMENT_CHANNEL_SETTING: ChannelSetting = {
  read: (guildId) => guildSettingsRepository.getAnnouncementChannel(guildId),
  store: (guildId, channelId) =>
    guildSettingsRepository.setAnnouncementChannel(guildId, channelId),
  action: 'SETTINGS_CHANGE',
  auditTarget: () => undefined,
  detail: (locale, channelId) =>
    channelId
      ? t('audit.details.announcementChannelSet', locale, {
          channel: channelId,
        })
      : t('audit.details.announcementChannelCleared', locale),
  deliverClearToPrevious: false,
};

export interface ChannelSettingChange {
  client: Client;
  guild: Guild;
  userId: string;
  /** The validated channel to use, or null to clear the setting. */
  channelId: string | null;
}

/**
 * Store a channel setting and audit-log it. Switching audit logging or
 * announcements off is as much a change on record as switching it on;
 * clearing what was never set records nothing. Validation is the caller's.
 *
 * The audit entry is fired, not awaited: its row is written before this
 * returns, and posting it to the audit channel must not hold up the reply.
 */
export function saveChannelSetting(
  setting: ChannelSetting,
  change: ChannelSettingChange
): void {
  const { client, guild, userId, channelId } = change;
  const auditLocale = resolveBackgroundLocale(guild);

  if (channelId === null) {
    const previous = setting.read(guild.id);
    setting.store(guild.id, null);
    if (!previous) return;

    void logAuditAction(
      client,
      guild.id,
      userId,
      setting.action,
      undefined,
      setting.detail(auditLocale, null),
      setting.deliverClearToPrevious ? { deliverTo: previous } : {}
    );
    return;
  }

  setting.store(guild.id, channelId);
  void logAuditAction(
    client,
    guild.id,
    userId,
    setting.action,
    setting.auditTarget(channelId),
    setting.detail(auditLocale, channelId)
  );
}
