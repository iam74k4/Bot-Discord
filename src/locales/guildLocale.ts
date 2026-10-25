import { GuildFeature } from 'discord.js';
import { guildSettingsRepository } from '../infrastructure/guildSettings/index.js';
import { mapDiscordLocale } from './index.js';
import { SUPPORTED_LOCALES, type Locale } from './types.js';

/**
 * Language of channel-wide posts on a guild that set none and whose Discord
 * server language cannot be trusted. Kept apart from `DEFAULT_LOCALE`
 * ('en'), which still answers viewers whose client language is unsupported:
 * this bot's servers are Japanese-first.
 */
export const DEFAULT_BACKGROUND_LOCALE: Locale = 'ja';

/** The parts of a guild that decide the language of its channel posts. */
export interface BackgroundLocaleGuild {
  id: string;
  preferredLocale?: string | null;
  features?: readonly string[] | null;
}

/**
 * Value stored in `guild_settings.language` meaning "follow the viewer".
 * Persisted as NULL so a guild that never chose a language keeps the
 * per-user behaviour the bot had before guild languages were honoured.
 */
export const LANGUAGE_AUTO = 'auto';

function isLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' && SUPPORTED_LOCALES.includes(value as Locale)
  );
}

/**
 * Language configured for a guild, or null when it follows the viewer.
 * `getLanguage` already degrades to null on a database failure, so locale
 * resolution never takes down the interaction that asked for a string.
 */
export function getGuildLanguage(
  guildId: string | null | undefined
): Locale | null {
  if (!guildId) return null;

  const language = guildSettingsRepository.getLanguage(guildId);
  return isLocale(language) ? language : null;
}

/**
 * Guild setting wins; otherwise the caller's fallback applies.
 * Channel-wide posts should use `resolveBackgroundLocale`, which picks a
 * fallback that is right for servers on "auto".
 */
export function resolveGuildLocale(
  guildId: string | null | undefined,
  fallback: Locale
): Locale {
  return getGuildLanguage(guildId) ?? fallback;
}

/**
 * Resolve the locale for posts the whole server sees: VC notifications, the
 * welcome message, the recording disclosure, the audit channel, broadcasts.
 *
 * Precedence: the guild's own setting > Discord's server language, but only
 * on Community servers > Japanese. Discord lets only Community servers
 * change their server language; everywhere else it is stuck on `en-US`, so
 * trusting it would post English into Japanese servers that never chose it.
 */
export function resolveBackgroundLocale(
  guild: BackgroundLocaleGuild | null | undefined
): Locale {
  if (!guild) return DEFAULT_BACKGROUND_LOCALE;

  const configured = getGuildLanguage(guild.id);
  if (configured) return configured;

  if (
    guild.preferredLocale &&
    guild.features?.includes(GuildFeature.Community)
  ) {
    return mapDiscordLocale(guild.preferredLocale);
  }

  return DEFAULT_BACKGROUND_LOCALE;
}

/**
 * Resolve the locale for a reply to an interaction.
 * Precedence: guild setting > the user's Discord client language > default.
 * In DMs there is no guild, so the user's language always wins.
 */
export function resolveLocale(interaction: {
  guildId: string | null;
  locale: string;
}): Locale {
  return resolveGuildLocale(
    interaction.guildId,
    mapDiscordLocale(interaction.locale)
  );
}
