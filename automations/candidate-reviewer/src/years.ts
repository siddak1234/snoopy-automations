import type { Role } from './reading.js';

/**
 * Years of experience, worked out here from the dates the resume printed — never by the model
 * (the spec's §4). A date is `YYYY-MM`, or `YYYY` when only the year is printed, which counts
 * from its January; a role printed as current runs to `now`. Roles that overlap are counted
 * once. A role without a start this can read has no years, and a resume none of whose roles
 * has one shows no years at all: null, which the score's flags say ("years not shown").
 */

/** A month as a count from year 0: `2021-03` is 2021 × 12 + 2. */
type Month = number;

/** A printed date as a month, or `undefined` when it is not one this reads. */
export function monthOf(date: string, now: Date): Month | undefined {
  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-\d{1,2})?$/u.exec(date.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const month0 = year * 12 + month - 1;
  if (year < 1950 || month < 1 || month > 12 || month0 > nowMonth(now)) return undefined;
  return month0;
}

const nowMonth = (now: Date): Month => now.getUTCFullYear() * 12 + now.getUTCMonth();

/** A role's months, from its start to its end — or to `now` when it is current — or undefined. */
export function spanOf(role: Role, now: Date): [Month, Month] | undefined {
  const start = monthOf(role.start, now);
  const end = role.current ? nowMonth(now) : monthOf(role.end, now);
  if (start === undefined || end === undefined || end < start) return undefined;
  return [start, end];
}

/** Whole years in a number of months, as a line says them: "under a year", "1 year", "4 years". */
export function yearsLine(months: number): string {
  const years = Math.floor(months / 12);
  if (years === 0) return 'under a year';
  return years === 1 ? '1 year' : `${years} years`;
}

/**
 * The candidate's years of experience, to one decimal place, from every dated role, overlaps
 * counted once; 0 when the resume lists no role, and null when it lists roles and none is dated.
 */
export function yearsOfExperience(roles: readonly Role[], now: Date): number | null {
  if (roles.length === 0) return 0;
  const spans = roles
    .map((role) => spanOf(role, now))
    .filter((span): span is [Month, Month] => span !== undefined)
    .sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return null;
  let months = 0;
  let [from, to] = spans[0]!;
  for (const [start, end] of spans.slice(1)) {
    if (start <= to) {
      to = Math.max(to, end);
      continue;
    }
    months += to - from;
    [from, to] = [start, end];
  }
  months += to - from;
  return Math.floor((months / 12) * 10) / 10;
}

/** A role's line: "2021 – now · 4 years", "2018 – 2021 · 3 years", or "years not shown". */
export function periodLine(role: Role, now: Date): string {
  const span = spanOf(role, now);
  if (span === undefined) return 'years not shown';
  const year = (month: Month) => String(Math.floor(month / 12));
  const until = role.current ? 'now' : year(span[1]);
  return `${year(span[0])} – ${until} · ${yearsLine(span[1] - span[0])}`;
}
