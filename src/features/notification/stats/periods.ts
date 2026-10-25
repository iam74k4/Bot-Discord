import { dayKey, shiftDay } from './calendar.js';

/** The periods `/notification stats` offers, in menu order. */
export const STATS_PERIODS = ['today', 'week', 'month', 'all'] as const;

export type StatsPeriod = (typeof STATS_PERIODS)[number];

export function isStatsPeriod(value: unknown): value is StatsPeriod {
  return STATS_PERIODS.includes(value as StatsPeriod);
}

/**
 * First day a period covers, in the stats zone, or undefined for all time.
 * Windows are whole calendar days ending today: "last 7 days" is today and
 * the six days before it, so the label means exactly what it says.
 */
export function periodStartDay(
  period: StatsPeriod,
  now: number = Date.now()
): string | undefined {
  const today = dayKey(now);
  switch (period) {
    case 'today':
      return today;
    case 'week':
      return shiftDay(today, -6);
    case 'month':
      return shiftDay(today, -29);
    case 'all':
      return undefined;
  }
}
