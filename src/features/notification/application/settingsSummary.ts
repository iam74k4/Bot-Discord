import { t } from '../../../locales/index.js';
import {
  formatSettingValue,
  type SettingsSummaryContext,
  type SettingsSummaryField,
} from '../../../shared/settingsSummary/index.js';
import { notificationChannelRepository } from '../repositories/notificationChannelRepository.js';

/**
 * The notification part of `/admin settings view`: where VC and welcome
 * notifications go, or how to set them up.
 */
export function notificationSettingsSummary({
  guildId,
  locale,
}: SettingsSummaryContext): SettingsSummaryField[] {
  const voice = notificationChannelRepository.getEnabled(guildId, 'voice');
  const welcome = notificationChannelRepository.getEnabled(
    guildId,
    'member_join'
  );

  return [
    {
      name: t('notification.summary.voice', locale),
      value: formatSettingValue(
        voice ? `<#${voice}>` : null,
        locale,
        'notification voice set'
      ),
      inline: true,
    },
    {
      name: t('notification.summary.welcome', locale),
      value: formatSettingValue(
        welcome ? `<#${welcome}>` : null,
        locale,
        'notification welcome set'
      ),
      inline: true,
    },
  ];
}
