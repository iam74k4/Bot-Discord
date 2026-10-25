import type { Guild } from 'discord.js';
import { t, type Locale } from '../../locales/index.js';
import { commandMention } from '../utils/commandMentions.js';
import { getErrorMessage, logger } from '../utils/logger.js';

/**
 * One place to read every feature's server settings.
 *
 * `/admin settings view` should show the whole setup - notification channels,
 * VC auto-join, exclusions - but features never import each other. Each
 * feature registers a read-only provider here in `start()` (and removes it in
 * `stop()`); the admin overview renders whatever is registered. This follows
 * the help catalog's pattern.
 */

/** One embed field: a setting's name and its current value. */
export interface SettingsSummaryField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface SettingsSummaryContext {
  guildId: string;
  /** Lets a provider resolve channel names or check permissions. */
  guild?: Guild | null;
  locale: Locale;
}

export type SettingsSummaryProvider = (
  context: SettingsSummaryContext
) => SettingsSummaryField[] | Promise<SettingsSummaryField[]>;

interface Registration {
  id: string;
  order: number;
  provider: SettingsSummaryProvider;
}

const registrations = new Map<string, Registration>();

/**
 * Add a feature's settings to the overview.
 * @param id stable name, e.g. 'notification'; registering it twice replaces
 * the earlier provider (a feature restarting)
 * @param options.order lower comes first; ties sort by id
 * @returns a function that removes this provider again
 */
export function registerSettingsSummary(
  id: string,
  provider: SettingsSummaryProvider,
  options: { order?: number } = {}
): () => void {
  const registration: Registration = {
    id,
    order: options.order ?? 100,
    provider,
  };
  registrations.set(id, registration);

  return () => {
    if (registrations.get(id) === registration) registrations.delete(id);
  };
}

/**
 * Every registered feature's fields, in order. A provider that throws is
 * logged and skipped: one broken feature must not blank the whole overview.
 */
export async function collectSettingsSummaries(
  context: SettingsSummaryContext
): Promise<SettingsSummaryField[]> {
  const ordered = [...registrations.values()].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id)
  );

  const results = await Promise.allSettled(
    ordered.map(async (registration) => registration.provider(context))
  );

  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    logger.warn(
      `Settings summary "${ordered[index].id}" failed: ${getErrorMessage(result.reason)}`
    );
    return [];
  });
}

/**
 * A setting's value for the overview, turning an unset one into a setup hint:
 * `未設定（</notification voice set:ID> で設定できます）`.
 */
export function formatSettingValue(
  value: string | null | undefined,
  locale: Locale,
  setupCommand?: string
): string {
  if (value) return value;
  return setupCommand
    ? t('common.notSetWithHint', locale, {
        command: commandMention(setupCommand),
      })
    : t('common.notSet', locale);
}

/** Remove every provider (tests). */
export function clearSettingsSummaries(): void {
  registrations.clear();
}
