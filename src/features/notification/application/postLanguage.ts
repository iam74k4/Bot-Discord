import { t, type Locale } from '../../../locales/index.js';
import {
  getGuildLanguage,
  resolveBackgroundLocale,
  type BackgroundLocaleGuild,
} from '../../../locales/guildLocale.js';
import { commandMention } from '../../../shared/utils/commandMentions.js';

/** Language names as their speakers write them, whatever the reader's locale. */
const LANGUAGE_NAMES: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
};

export interface PostLanguage {
  /** `日本語` / `English`: the language VC and welcome posts go out in. */
  name: string;
  /**
   * Set when the server is on "auto" and the posts are in a different
   * language from the reader's replies, which otherwise looks like a bug.
   */
  hint: string | null;
}

/**
 * The language channel-wide notifications are posted in, as a reader of a
 * setup reply should see it. Replies follow the reader's Discord language,
 * but posts follow the server (see `resolveBackgroundLocale`), so an admin can
 * get a Japanese confirmation for notifications that arrive in English, or
 * the other way round.
 */
export function describePostLanguage(
  guild: BackgroundLocaleGuild,
  readerLocale: Locale
): PostLanguage {
  const postLocale = resolveBackgroundLocale(guild);
  const name = LANGUAGE_NAMES[postLocale];
  const hint =
    getGuildLanguage(guild.id) === null && postLocale !== readerLocale
      ? t('notification.language.autoHint', readerLocale, {
          language: name,
          command: commandMention('admin settings language'),
        })
      : null;

  return { name, hint };
}

/** The post-language lines appended to a setup confirmation. */
export function postLanguageLines(
  guild: BackgroundLocaleGuild,
  readerLocale: Locale
): string[] {
  const { name, hint } = describePostLanguage(guild, readerLocale);
  const line = t('notification.language.line', readerLocale, {
    language: name,
  });
  return hint ? [line, hint] : [line];
}
