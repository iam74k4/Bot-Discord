import { t, type Locale, type TranslationKey } from './index.js';

/**
 * Locale-aware formatting shared by every feature.
 *
 * Numbers and units are spelled out through translation keys rather than
 * `Intl.NumberFormat`'s unit style: on Node 22 that renders Japanese as
 * `5 分` (with a space) and has no `Intl.DurationFormat` to fall back on.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;

/** BCP 47 tag for `Intl` APIs, per supported locale. */
const INTL_TAGS: Record<Locale, string> = { ja: 'ja-JP', en: 'en-US' };

export interface DurationFormatOptions {
  /**
   * `short` (default): `1時間23分` / `1h 23m`, for compact figures such as
   * stats. `long`: `1時間23分` / `1 hour 23 minutes`, for sentences such as
   * "saved the last 5 minutes". Japanese reads the same either way.
   */
  style?: 'short' | 'long';
  /**
   * `minutes` (default) rounds down to whole minutes and shows anything
   * under a minute as "less than a minute". `seconds` keeps seconds when the
   * total is under an hour (`1分30秒`, `30秒`).
   */
  precision?: 'minutes' | 'seconds';
}

type Unit = 'hours' | 'minutes' | 'seconds';

function unitText(
  unit: Unit,
  count: number,
  locale: Locale,
  style: 'short' | 'long'
): string {
  if (style === 'short') {
    return t(`common.duration.short.${unit}` as TranslationKey, locale, {
      count,
    });
  }

  const form =
    new Intl.PluralRules(INTL_TAGS[locale]).select(count) === 'one'
      ? 'One'
      : 'Other';
  return t(`common.duration.long.${unit}${form}` as TranslationKey, locale, {
    count,
  });
}

function pair(first: string, second: string, locale: Locale): string {
  return t('common.duration.pair', locale, { first, second });
}

/**
 * A duration in the reader's language: `formatDuration(83 * 60_000, 'ja')`
 * is `1時間23分`, and `'1h 23m'` in English.
 *
 * Zero units are dropped (`2時間`, not `2時間0分`); a true zero reads `0分`.
 * Negative and non-finite inputs are treated as zero.
 */
export function formatDuration(
  ms: number,
  locale: Locale,
  options: DurationFormatOptions = {}
): string {
  const style = options.style ?? 'short';
  const precision = options.precision ?? 'minutes';
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;

  if (precision === 'seconds') {
    const totalSeconds = Math.floor(safeMs / MS_PER_SECOND);
    const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
    const seconds = totalSeconds % SECONDS_PER_MINUTE;

    if (totalMinutes === 0) {
      return unitText('seconds', seconds, locale, style);
    }
    if (totalMinutes < MINUTES_PER_HOUR) {
      const minutesText = unitText('minutes', totalMinutes, locale, style);
      return seconds === 0
        ? minutesText
        : pair(
            minutesText,
            unitText('seconds', seconds, locale, style),
            locale
          );
    }
    // Past an hour, seconds are noise: fall through to minute precision.
  }

  const totalMinutes = Math.floor(safeMs / MS_PER_MINUTE);
  if (totalMinutes === 0) {
    return safeMs > 0
      ? t(`common.duration.${style}.lessThanMinute` as TranslationKey, locale)
      : unitText('minutes', 0, locale, style);
  }

  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;

  if (hours === 0) return unitText('minutes', minutes, locale, style);

  const hoursText = unitText('hours', hours, locale, style);
  return minutes === 0
    ? hoursText
    : pair(hoursText, unitText('minutes', minutes, locale, style), locale);
}

/** `1,234` in both languages, with the locale's own grouping. */
export function formatNumber(value: number, locale: Locale): string {
  return value.toLocaleString(INTL_TAGS[locale]);
}

/**
 * Join items the way the language lists them: `A、B、C` in Japanese,
 * `A, B, and C` in English.
 */
export function formatList(items: readonly string[], locale: Locale): string {
  return new Intl.ListFormat(INTL_TAGS[locale], {
    style: 'long',
    type: 'conjunction',
  }).format(items);
}
