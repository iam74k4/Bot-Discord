/**
 * Calendar days for VC stats, in one configured time zone.
 *
 * The rollup (`voice_daily_stats`) is keyed by day, and "today" / "last 7
 * days" are read back by day, so both sides must agree on where a day starts.
 * That used to be the process time zone, which is UTC on Railway unless `TZ`
 * is set: for a Japanese server "today" then ran from 09:00 to 09:00. The zone
 * is now set once from `STATS_TIMEZONE` when the feature starts, and defaults
 * to Japan time so tests and scripts that never start the feature agree with
 * production.
 */

export const DEFAULT_STATS_TIME_ZONE = 'Asia/Tokyo';

/** A visit longer than this is split into at most this many day rows. */
const MAX_SEGMENTS = 400;

let timeZone = DEFAULT_STATS_TIME_ZONE;
// Built on first use, not at import time.
let partsFormatter: Intl.DateTimeFormat | null = null;

function createFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * Use `zone` for every day boundary from now on.
 * @throws RangeError when `zone` is not an IANA time zone
 */
export function setStatsTimeZone(zone: string): void {
  const formatter = createFormatter(zone);
  timeZone = formatter.resolvedOptions().timeZone;
  partsFormatter = formatter;
}

/** The zone day boundaries are computed in, e.g. `Asia/Tokyo`. */
export function getStatsTimeZone(): string {
  return timeZone;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(ms: number): ZonedParts {
  partsFormatter ??= createFormatter(timeZone);
  const parts: Partial<Record<keyof ZonedParts, number>> = {};
  for (const part of partsFormatter.formatToParts(ms)) {
    if (part.type !== 'literal') {
      parts[part.type as keyof ZonedParts] = Number(part.value);
    }
  }
  return parts as ZonedParts;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` of the calendar day `ms` falls in, in the stats zone. */
export function dayKey(ms: number): string {
  const { year, month, day } = zonedParts(ms);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDay(day: string): [number, number, number] {
  const [year, month, date] = day.split('-').map(Number);
  return [year, month, date];
}

/** The day `delta` calendar days after `day` (negative goes back). */
export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = parseDay(day);
  return new Date(Date.UTC(year, month - 1, date + delta))
    .toISOString()
    .slice(0, 10);
}

/** How far the stats zone is ahead of UTC at `ms`. */
function offsetAt(ms: number): number {
  const p = zonedParts(ms);
  const wallClock = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  return wallClock - Math.floor(ms / 1000) * 1000;
}

/** The instant `day` starts (00:00) in the stats zone. */
export function startOfDay(day: string): number {
  const [year, month, date] = parseDay(day);
  const midnightUtc = Date.UTC(year, month - 1, date);
  // Second pass corrects for a DST change between UTC and local midnight.
  const firstGuess = midnightUtc - offsetAt(midnightUtc);
  return midnightUtc - offsetAt(firstGuess);
}

export interface DaySegment {
  day: string;
  durationMs: number;
}

/**
 * Split `[startMs, endMs)` at each midnight of the stats zone, so a visit
 * from 23:30 to 01:00 counts 30 minutes on one day and an hour on the next.
 */
export function daySegments(startMs: number, endMs: number): DaySegment[] {
  const segments: DaySegment[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const day = dayKey(cursor);
    const nextDayStart = startOfDay(shiftDay(day, 1));
    // A zone without a midnight on some day must not stall the loop.
    const end =
      nextDayStart > cursor && segments.length < MAX_SEGMENTS - 1
        ? Math.min(endMs, nextDayStart)
        : endMs;
    segments.push({ day, durationMs: end - cursor });
    cursor = end;
  }

  return segments;
}
