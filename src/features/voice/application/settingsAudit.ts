import type { Client, Guild } from 'discord.js';
import { t, type Locale } from '../../../locales/index.js';
import { resolveBackgroundLocale } from '../../../locales/guildLocale.js';
import { formatList } from '../../../locales/format.js';
import { logAuditAction } from '../../../infrastructure/audit/index.js';

/** A change to the guild's auto-join settings, as the audit trail records it. */
export type VoiceSettingChange =
  | { kind: 'autoJoinEnabled' }
  | { kind: 'autoJoinDisabled' }
  | { kind: 'channelExcluded'; channelId: string }
  | { kind: 'channelIncluded'; channelId: string }
  | {
      kind: 'exclusionsChanged';
      added: readonly string[];
      removed: readonly string[];
    };

/** Where the change was made: a slash command (by its path), the panel or the notice button. */
export type VoiceSettingSource =
  { command: string } | 'statusPanel' | 'noticeButton';

function via(source: VoiceSettingSource, locale: Locale): string {
  if (source === 'statusPanel') {
    return t('record.audit.viaPanel', locale, { command: '/voice status' });
  }
  if (source === 'noticeButton') {
    return t('record.audit.viaNoticeButton', locale);
  }
  return t('record.audit.viaCommand', locale, {
    command: `/${source.command}`,
  });
}

function channels(ids: readonly string[], locale: Locale): string {
  return ids.length > 0
    ? formatList(
        ids.map((id) => `<#${id}>`),
        locale
      )
    : t('record.autojoin.exclusionsNone', locale);
}

/** The audit detail line for a change, in `locale`. */
export function describeVoiceSettingChange(
  change: VoiceSettingChange,
  source: VoiceSettingSource,
  locale: Locale
): string {
  const from = via(source, locale);
  switch (change.kind) {
    case 'autoJoinEnabled':
      return t('record.audit.autoJoinEnabled', locale, { via: from });
    case 'autoJoinDisabled':
      return t('record.audit.autoJoinDisabled', locale, { via: from });
    case 'channelExcluded':
      return t('record.audit.channelExcluded', locale, {
        channel: change.channelId,
        via: from,
      });
    case 'channelIncluded':
      return t('record.audit.channelIncluded', locale, {
        channel: change.channelId,
        via: from,
      });
    case 'exclusionsChanged':
      return t('record.audit.exclusionsChanged', locale, {
        added: channels(change.added, locale),
        removed: channels(change.removed, locale),
        via: from,
      });
  }
}

/**
 * Record an auto-join change in the guild's audit trail. Like every audit
 * entry it is written in the server's language, not the admin's: the audit
 * channel is read by the whole moderation team. Fire and forget.
 */
export function auditVoiceSettingChange(
  client: Client,
  guild: Guild,
  userId: string,
  change: VoiceSettingChange,
  source: VoiceSettingSource
): void {
  void logAuditAction(
    client,
    guild.id,
    userId,
    'SETTINGS_CHANGE',
    undefined,
    describeVoiceSettingChange(change, source, resolveBackgroundLocale(guild))
  );
}
