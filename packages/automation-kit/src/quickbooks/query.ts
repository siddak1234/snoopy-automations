/**
 * QuickBooks query text, built the one way every lookup sends it.
 *
 * The text travels as `query.run`'s `query` input; the platform's Connections puts it
 * in the URL with `URLSearchParams`, which percent-encodes every character a value can
 * hold and writes a space as `+`, the form Intuit's own example uses — so nothing in a
 * value can break the URL. What can break is the QUERY: a value is quoted here, and a
 * step builds its text once and sends exactly those bytes on every attempt, because the
 * platform refuses a different request under a used idempotency key with 409.
 */

/** An entity or field name as Intuit spells it: `Account`, `FullyQualifiedName`. */
const NAME = /^[A-Z][A-Za-z]*$/u;

/** Intuit's own ceiling on one query's rows. */
const MAXIMUM_RESULTS = 1_000;

/**
 * A value as a query literal: every backslash doubled FIRST, then a backslash before
 * every apostrophe, the whole inside apostrophes — `O'Brien's Fees` is sent as
 * `'O\'Brien\'s Fees'`. Intuit documents only the apostrophe escape; the backslash goes
 * first, or a value ending in one (or holding one before an apostrophe) would close the
 * literal early and let the rest be read as query text. Nothing else changes: a double
 * quote, `&`, `#`, `%` (a wildcard only in LIKE) and a curly apostrophe stay as typed.
 */
export function quoteQueryValue(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * Every record of `entity` — active or not — whose `field` equals `value`, at most
 * `maxResults` of them:
 * `SELECT * FROM Account WHERE FullyQualifiedName = 'Utilities:Electric' AND Active IN (true, false) MAXRESULTS 2`.
 * Intuit compares the value without case, so a caller re-checks each returned row.
 * A name or bound outside Intuit's shapes is the caller's mistake, refused here.
 */
export function lookupQuery(
  entity: string,
  field: string,
  value: string,
  maxResults: number,
): string {
  if (!NAME.test(entity)) throw new Error(`${entity} is not a QuickBooks entity name`);
  if (!NAME.test(field)) throw new Error(`${field} is not a QuickBooks field name`);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAXIMUM_RESULTS) {
    throw new Error(`MAXRESULTS must be a whole number from 1 to ${MAXIMUM_RESULTS}`);
  }
  return `SELECT * FROM ${entity} WHERE ${field} = ${quoteQueryValue(value)} AND Active IN (true, false) MAXRESULTS ${maxResults}`;
}
