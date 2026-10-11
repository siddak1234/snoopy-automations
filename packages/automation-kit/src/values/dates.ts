/**
 * Calendar dates as `YYYY-MM-DD` strings (ip-review design-checks-rules-and-approval.json,
 * cross_cutting[0] item 3; Group 3's D3): real days of the calendar from 2000 on, compared as
 * strings, counted in UTC.
 */

/** No document this automation records is dated before this year (Group 3's D3). */
export const EARLIEST_YEAR = 2000;

/** One date as read: none printed, printed but not a real day, or a real day. */
export type DateReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'date'; readonly date: string };

const NONE: DateReading = { kind: 'none' };
const INVALID: DateReading = { kind: 'invalid' };
const DAY_MS = 86_400_000;

/**
 * A printed date: trimmed, it must be `YYYY-MM-DD` and come back identical from `Date.UTC` — so
 * `2026-02-29`, `2026-04-31`, `2026-13-01` and `2026-1-05` are not dates and `2028-02-29` is —
 * and fall in 2000 or later. Null, or nothing but spaces, is none printed.
 */
export function parseDate(value: unknown): DateReading {
  if (value === null || value === undefined) return NONE;
  if (typeof value !== 'string') return INVALID;
  const text = value.trim();
  if (text === '') return NONE;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) return INVALID;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < EARLIEST_YEAR) return INVALID;
  const date = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return date === text ? { kind: 'date', date } : INVALID;
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** `date` moved by `days` whole days (back when negative), in UTC. */
export function addDays(date: string, days: number): string {
  return utcDay(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** Whether `date` falls from `from` to `to`, both days included. */
export function isWithin(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}
