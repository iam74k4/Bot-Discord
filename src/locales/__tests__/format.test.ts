import { describe, expect, it } from 'vitest';
import { formatDuration, formatList, formatNumber } from '../format.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('formatDuration', () => {
  describe('short style, minute precision (the default)', () => {
    it.each([
      [83 * MINUTE, '1時間23分', '1h 23m'],
      [2 * HOUR, '2時間', '2h'],
      [45 * MINUTE, '45分', '45m'],
      [1 * MINUTE, '1分', '1m'],
      [26 * HOUR + 5 * MINUTE, '26時間5分', '26h 5m'],
    ])('%d ms reads %s / %s', (ms, ja, en) => {
      expect(formatDuration(ms, 'ja')).toBe(ja);
      expect(formatDuration(ms, 'en')).toBe(en);
    });

    it('rounds down to whole minutes', () => {
      expect(formatDuration(59 * MINUTE + 59 * SECOND, 'ja')).toBe('59分');
      expect(formatDuration(HOUR + 59 * SECOND, 'en')).toBe('1h');
    });

    it('says "under a minute" for a short visit instead of 0', () => {
      expect(formatDuration(40 * SECOND, 'ja')).toBe('1分未満');
      expect(formatDuration(1, 'en')).toBe('<1m');
    });

    it.each([0, -5 * MINUTE, Number.NaN, Number.POSITIVE_INFINITY])(
      'reads a zero for %s',
      (ms) => {
        expect(formatDuration(ms, 'ja')).toBe('0分');
        expect(formatDuration(ms, 'en')).toBe('0m');
      }
    );
  });

  describe('long style', () => {
    it.each([
      [HOUR + MINUTE, '1時間1分', '1 hour 1 minute'],
      [2 * HOUR + 23 * MINUTE, '2時間23分', '2 hours 23 minutes'],
      [5 * MINUTE, '5分', '5 minutes'],
      [30 * SECOND, '1分未満', 'less than a minute'],
    ])('%d ms reads %s / %s', (ms, ja, en) => {
      expect(formatDuration(ms, 'ja', { style: 'long' })).toBe(ja);
      expect(formatDuration(ms, 'en', { style: 'long' })).toBe(en);
    });
  });

  describe('second precision', () => {
    it.each([
      [30 * SECOND, '30秒', '30 seconds', '30s'],
      [1 * SECOND, '1秒', '1 second', '1s'],
      [MINUTE, '1分', '1 minute', '1m'],
      [90 * SECOND, '1分30秒', '1 minute 30 seconds', '1m 30s'],
      [5 * MINUTE, '5分', '5 minutes', '5m'],
      [0, '0秒', '0 seconds', '0s'],
    ])('%d ms reads %s / %s / %s', (ms, ja, enLong, enShort) => {
      expect(formatDuration(ms, 'ja', { precision: 'seconds' })).toBe(ja);
      expect(
        formatDuration(ms, 'en', { precision: 'seconds', style: 'long' })
      ).toBe(enLong);
      expect(formatDuration(ms, 'en', { precision: 'seconds' })).toBe(enShort);
    });

    it('drops seconds once the total passes an hour', () => {
      expect(
        formatDuration(HOUR + 2 * MINUTE + 3 * SECOND, 'ja', {
          precision: 'seconds',
        })
      ).toBe('1時間2分');
    });
  });
});

describe('formatNumber', () => {
  it('groups thousands in both languages', () => {
    expect(formatNumber(1234567, 'ja')).toBe('1,234,567');
    expect(formatNumber(1234, 'en')).toBe('1,234');
    expect(formatNumber(7, 'ja')).toBe('7');
  });
});

describe('formatList', () => {
  it('lists the way each language does', () => {
    expect(formatList(['A', 'B', 'C'], 'ja')).toBe('A、B、C');
    expect(formatList(['A', 'B', 'C'], 'en')).toBe('A, B, and C');
    expect(formatList(['A', 'B'], 'en')).toBe('A and B');
    expect(formatList(['A'], 'ja')).toBe('A');
  });
});
