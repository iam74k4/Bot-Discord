import { t, type Locale } from '../../../locales/index.js';
import {
  DEFAULT_BACKGROUND_LOCALE,
  LANGUAGE_AUTO,
  resolveBackgroundLocale,
  type BackgroundLocaleGuild,
} from '../../../locales/guildLocale.js';

/** Language names are shown in their own language, whoever is reading. */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  ja: '日本語',
  en: 'English',
};

/** Values the language setting accepts; `auto` is stored as NULL. */
export const SUPPORTED_LANGUAGE_VALUES = ['ja', 'en', LANGUAGE_AUTO] as const;

export function isSupportedLanguageValue(
  value: string | undefined
): value is (typeof SUPPORTED_LANGUAGE_VALUES)[number] {
  return (
    value !== undefined &&
    (SUPPORTED_LANGUAGE_VALUES as readonly string[]).includes(value)
  );
}

/** `日本語`, `English`, or the localized "automatic"; unknown codes as-is. */
export function languageDisplayName(value: string, locale: Locale): string {
  if (value === LANGUAGE_AUTO) return t('settings.language.auto', locale);
  return LANGUAGE_DISPLAY_NAMES[value] ?? value;
}

/**
 * The language channel posts would use if this guild were on automatic:
 * the same rule as `resolveBackgroundLocale`, minus the stored setting.
 */
export function automaticPostLocale(
  guild: Omit<BackgroundLocaleGuild, 'id'> | null | undefined
): Locale {
  if (!guild) return DEFAULT_BACKGROUND_LOCALE;
  // An empty id has no stored language, so only the fallback rule applies.
  return resolveBackgroundLocale({
    id: '',
    preferredLocale: guild.preferredLocale,
    features: guild.features,
  });
}
