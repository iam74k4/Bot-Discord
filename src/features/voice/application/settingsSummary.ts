import { t } from '../../../locales/index.js';
import type {
  SettingsSummaryContext,
  SettingsSummaryField,
} from '../../../shared/settingsSummary/index.js';
import { voiceSettingsRepository } from '../repositories/voiceSettingsRepository.js';
import { exclusionList } from './status.js';

/**
 * The voice part of `/admin settings view`: whether the bot joins occupied
 * VCs to keep audio, and which VCs it stays out of.
 */
export function voiceSettingsSummary({
  guildId,
  locale,
}: SettingsSummaryContext): SettingsSummaryField[] {
  const enabled = voiceSettingsRepository.isAutoJoinEnabled(guildId);
  return [
    {
      name: t('record.autojoin.title', locale),
      value: enabled
        ? t('record.autojoin.statusEnabled', locale)
        : t('record.autojoin.statusDisabled', locale),
      inline: true,
    },
    {
      name: t('record.autojoin.exclusions', locale),
      value: exclusionList(
        voiceSettingsRepository.listExclusions(guildId),
        locale
      ),
      inline: true,
    },
  ];
}
