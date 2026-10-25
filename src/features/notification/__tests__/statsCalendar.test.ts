import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STATS_TIME_ZONE,
  dayKey,
  daySegments,
  getStatsTimeZone,
  setStatsTimeZone,
  shiftDay,
  startOfDay,
} from '../stats/calendar.js';
import { isStatsPeriod, periodStartDay } from '../stats/periods.js';

/**
 * Day boundaries for VC stats. Every instant here is written in UTC so the
 * results cannot depend on the zone the test process happens to run in.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('stats calendar', () => {
  afterEach(() => {
    setStatsTimeZone(DEFAULT_STATS_TIME_ZONE);
  });

  describe('time zone', () => {
    it('defaults to Japan time', () => {
      expect(getStatsTimeZone()).toBe('Asia/Tokyo');
      // 15:00 UTC is midnight in Japan.
      expect(dayKey(Date.UTC(2026, 6, 14, 14, 59))).toBe('2026-07-14');
      expect(dayKey(Date.UTC(2026, 6, 14, 15, 0))).toBe('2026-07-15');
    });

    it('stores the canonical zone name', () => {
      setStatsTimeZone('europe/london');

      expect(getStatsTimeZone()).toBe('Europe/London');
    });

    it('rejects a zone that does not exist and keeps the current one', () => {
      expect(() => setStatsTimeZone('Mars/Olympus_Mons')).toThrow(RangeError);
      expect(getStatsTimeZone()).toBe('Asia/Tokyo');
    });

    it('moves day boundaries to the configured zone', () => {
      setStatsTimeZone('UTC');

      expect(dayKey(Date.UTC(2026, 6, 14, 23, 59))).toBe('2026-07-14');
      expect(startOfDay('2026-07-15')).toBe(Date.UTC(2026, 6, 15));
    });
  });

  describe('shiftDay', () => {
    it.each([
      ['2026-07-15', -6, '2026-07-09'],
      ['2026-03-01', -1, '2026-02-28'],
      ['2024-03-01', -1, '2024-02-29'],
      ['2026-01-05', -29, '2025-12-07'],
      ['2026-12-31', 1, '2027-01-01'],
    ])('%s %+d days is %s', (day, delta, expected) => {
      expect(shiftDay(day, delta)).toBe(expected);
    });
  });

  describe('startOfDay', () => {
    it('is midnight in Japan', () => {
      expect(startOfDay('2026-07-15')).toBe(Date.UTC(2026, 6, 14, 15));
    });

    it('follows a daylight-saving change', () => {
      setStatsTimeZone('America/New_York');

      // EST (UTC-5) before 2026-03-08, EDT (UTC-4) from that day on.
      expect(startOfDay('2026-03-08')).toBe(Date.UTC(2026, 2, 8, 5));
      expect(startOfDay('2026-03-09')).toBe(Date.UTC(2026, 2, 9, 4));
    });
  });

  describe('daySegments', () => {
    const midnight = Date.UTC(2026, 6, 14, 15); // 2026-07-15 00:00 JST

    it('keeps a visit inside one day whole', () => {
      expect(daySegments(midnight + HOUR, midnight + 2 * HOUR)).toEqual([
        { day: '2026-07-15', durationMs: HOUR },
      ]);
    });

    it('splits a visit at midnight', () => {
      expect(
        daySegments(midnight - 30 * MINUTE, midnight + 45 * MINUTE)
      ).toEqual([
        { day: '2026-07-14', durationMs: 30 * MINUTE },
        { day: '2026-07-15', durationMs: 45 * MINUTE },
      ]);
    });

    it('gives a visit spanning whole days one segment per day', () => {
      const segments = daySegments(midnight - HOUR, midnight + 48 * HOUR);

      expect(segments.map((s) => [s.day, s.durationMs / HOUR])).toEqual([
        ['2026-07-14', 1],
        ['2026-07-15', 24],
        ['2026-07-16', 24],
      ]);
    });

    it('is empty for a visit with no length', () => {
      expect(daySegments(midnight, midnight)).toEqual([]);
    });

    it('handles the 23-hour day of a daylight-saving change', () => {
      setStatsTimeZone('America/New_York');
      const start = Date.UTC(2026, 2, 8, 5); // 2026-03-08 00:00 EST

      const segments = daySegments(start, start + 24 * HOUR);

      expect(segments).toEqual([
        { day: '2026-03-08', durationMs: 23 * HOUR },
        { day: '2026-03-09', durationMs: HOUR },
      ]);
    });
  });

  describe('periods', () => {
    const noon = Date.UTC(2026, 6, 15, 3); // 12:00 JST

    it.each([
      ['today', '2026-07-15'],
      ['week', '2026-07-09'],
      ['month', '2026-06-16'],
      ['all', undefined],
    ] as const)('%s starts on %s', (period, expected) => {
      expect(periodStartDay(period, noon)).toBe(expected);
    });

    it('starts "today" on the Japanese date just after midnight there', () => {
      // 00:05 JST on the 15th is still the 14th in UTC.
      expect(periodStartDay('today', Date.UTC(2026, 6, 14, 15, 5))).toBe(
        '2026-07-15'
      );
    });

    it.each([
      ['today', true],
      ['all', true],
      ['decade', false],
      [null, false],
    ])('isStatsPeriod(%s) is %s', (value, expected) => {
      expect(isStatsPeriod(value)).toBe(expected);
    });
  });
});
