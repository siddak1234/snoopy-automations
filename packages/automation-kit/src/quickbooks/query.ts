/**
 * QuickBooks query text, built the one way every lookup sends it.
 *
 * The text travels as `query.run`'s `query` input; the platform's Connections puts it
 * in the URL with `URLSearchParams`, which percent-encodes every character a value can
 * hold and writes a space as `+`, the form Intuit's own example uses — so nothing in a
 * value can break the URL. What can break is the QUERY: a value is quoted here, and a
 * step builds its text once and sends exactly those bytes on every attempt, because the
 * platform refuses a different request under a used idempotency key with 409.
 *
 * Intuit's query language (developer.intuit.com, "Query operations and syntax"): the
 * operators IN, =, <, >, <=, >= and LIKE; conditions joined by AND, and no OR; MAXRESULTS
 * at most 1,000. Only a name list — an account, a vendor, an employee — can be inactive,
 * so only a lookup on one asks for `Active IN (true, false)`; a transaction never does.
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

function nameOf(name: string, what: 'entity' | 'field'): string {
  if (!NAME.test(name)) throw new Error(`${name} is not a QuickBooks ${what} name`);
  return name;
}

function boundOf(maxResults: number): number {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAXIMUM_RESULTS) {
    throw new Error(`MAXRESULTS must be a whole number from 1 to ${MAXIMUM_RESULTS}`);
  }
  return maxResults;
}

/** `(value, value)` for IN: at least one value, and no value twice, compared as Intuit compares them — without case. */
function listOf(values: readonly string[]): string {
  if (values.length === 0) throw new Error('IN needs at least one value');
  const seen = new Set<string>();
  for (const value of values) {
    const folded = value.toLowerCase();
    if (seen.has(folded)) throw new Error('IN names a value twice');
    seen.add(folded);
  }
  return `(${values.map(quoteQueryValue).join(', ')})`;
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
  return `SELECT * FROM ${nameOf(entity, 'entity')} WHERE ${nameOf(field, 'field')} = ${quoteQueryValue(value)} AND Active IN (true, false) MAXRESULTS ${boundOf(maxResults)}`;
}

/**
 * Every record of `entity` — active or not — whose `field` is one of `values`, at most
 * `maxResults` of them: several names in ONE query, since a step makes one QuickBooks
 * call, and IN is a documented operator where OR is not —
 * `SELECT * FROM Account WHERE FullyQualifiedName IN ('Utilities:Electric', 'Checking') AND Active IN (true, false) MAXRESULTS 4`.
 * A value given twice, even in another case, is refused: Intuit would read it as one.
 */
export function lookupInQuery(
  entity: string,
  field: string,
  values: readonly string[],
  maxResults: number,
): string {
  return `SELECT * FROM ${nameOf(entity, 'entity')} WHERE ${nameOf(field, 'field')} IN ${listOf(values)} AND Active IN (true, false) MAXRESULTS ${boundOf(maxResults)}`;
}

/** The transactions a search may name: none of them is a name list, so none can be inactive. */
export const TRANSACTION_ENTITIES = ['Bill', 'Purchase', 'VendorCredit', 'JournalEntry'] as const;
export type TransactionEntity = (typeof TRANSACTION_ENTITIES)[number];

/** The comparisons Intuit documents besides IN and LIKE. */
export type Comparison = '=' | '<' | '>' | '<=' | '>=';
const COMPARISONS: ReadonlySet<string> = new Set(['=', '<', '>', '<=', '>=']);

/** One condition: a field compared with one value, or IN a list of values. */
export type QueryCondition =
  | { readonly field: string; readonly operator: Comparison; readonly value: string }
  | { readonly field: string; readonly operator: 'IN'; readonly values: readonly string[] };

export interface TransactionSearch {
  readonly entity: TransactionEntity;
  /** Joined by AND; at least one, so a search never lists a company's every record. */
  readonly where: readonly QueryCondition[];
  /** Newest first is `{ field: 'TxnDate', descending: true }`. */
  readonly orderBy?: { readonly field: string; readonly descending?: boolean };
  readonly maxResults: number;
}

function conditionOf(condition: QueryCondition): string {
  const field = nameOf(condition.field, 'field');
  if (condition.operator === 'IN') return `${field} IN ${listOf(condition.values)}`;
  if (!COMPARISONS.has(condition.operator)) {
    throw new Error(`${String(condition.operator)} is not a QuickBooks operator`);
  }
  return `${field} ${condition.operator} ${quoteQueryValue(condition.value)}`;
}

/**
 * A search of bills, expenses, vendor credits or journal entries: each condition's value
 * quoted as `lookupQuery` quotes it, the conditions joined by AND, and no Active
 * condition — Intuit documents that one for name lists only —
 * `SELECT * FROM Purchase WHERE TxnDate >= '2026-09-13' AND TxnDate <= '2026-10-04' ORDERBY TxnDate DESC MAXRESULTS 50`.
 * An amount is a value such as `'45.20'`, as Intuit's own example quotes one.
 */
export function transactionQuery(search: TransactionSearch): string {
  if (!(TRANSACTION_ENTITIES as readonly string[]).includes(search.entity)) {
    throw new Error(`${search.entity} is not a transaction a search may name`);
  }
  if (search.where.length === 0) throw new Error('a transaction search needs a condition');
  const where = search.where.map(conditionOf).join(' AND ');
  const order = search.orderBy
    ? ` ORDERBY ${nameOf(search.orderBy.field, 'field')}${search.orderBy.descending ? ' DESC' : ''}`
    : '';
  return `SELECT * FROM ${search.entity} WHERE ${where}${order} MAXRESULTS ${boundOf(search.maxResults)}`;
}

/** A real `YYYY-MM-DD` day of the calendar. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * The two conditions of a date range, both ends included: `TxnDate >= 'from' AND TxnDate <= 'to'`.
 * Each end a real `YYYY-MM-DD` day, and `from` not after `to`.
 */
export function dateRange(field: string, from: string, to: string): QueryCondition[] {
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw new Error('a date range needs two YYYY-MM-DD days');
  }
  if (from > to) throw new Error('a date range must not end before it starts');
  return [
    { field, operator: '>=', value: from },
    { field, operator: '<=', value: to },
  ];
}
