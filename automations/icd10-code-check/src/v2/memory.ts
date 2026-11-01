import { MEMORY_LIMITS, isObject } from '@autom8x/automation-sdk';

/**
 * The clinic's memory (the spec's v2 section, row 2: "learned later from what each clinic
 * accepts"): the codes its people accepted, each with how many times, kept in the workspace under
 * one key through the platform's flow memory. Read by `rank-codes`, written by `save-visit`.
 */
export const ACCEPTED_KEY = 'accepted-codes';

/** At most this many codes are kept, the most accepted first: well inside the memory's value bound. */
export const ACCEPTED_KEPT = 1_500;

const CODE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/u;

/** The kept counts, by code; anything out of shape read as none. */
export function acceptedOf(value: unknown): Record<string, number> {
  if (!isObject(value) || !isObject(value.codes)) return {};
  return Object.fromEntries(
    Object.entries(value.codes).filter(
      ([code, count]) => CODE.test(code) && Number.isInteger(count) && (count as number) > 0,
    ) as [string, number][],
  );
}

/** The counts with each newly accepted code once more, the most accepted `ACCEPTED_KEPT` kept. */
export function remember(
  before: Readonly<Record<string, number>>,
  accepted: readonly string[],
): { codes: Record<string, number> } {
  const counts = { ...before };
  for (const code of new Set(accepted)) counts[code] = (counts[code] ?? 0) + 1;
  const kept = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ACCEPTED_KEPT);
  const value = { codes: Object.fromEntries(kept) };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MEMORY_LIMITS.valueBytes) {
    throw new Error('the accepted codes pass the memory bound');
  }
  return value;
}
