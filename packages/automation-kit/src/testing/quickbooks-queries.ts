import type { JsonObject, ProviderAnswer } from '@autom8x/automation-sdk';

import {
  lookupInQuery,
  lookupLikeQuery,
  lookupQuery,
  transactionQuery,
  type QueryCondition,
  type TransactionEntity,
} from '../quickbooks/query.js';
import { faultAnswer, queryAnswer, type SimulatedCompany } from './quickbooks-company.js';

/**
 * QuickBooks answering `query.run` from the made-up company, by Intuit's documented rules
 * ("Query operations and syntax"; the filterable and sortable flags of its model file,
 * CodesModelsJsonObjects_v2.json, read 2026-10-11): values compared without case, IN, =,
 * <, >, <=, >= and LIKE (`%` its one wildcard) joined by AND — never OR — ORDERBY on a
 * sortable field, MAXRESULTS the most rows returned, and `Active IN (true, false)` on a name
 * list alone.
 *
 * It answers only the text the kit's builders write — `lookupQuery`, `lookupInQuery` and
 * `lookupLikeQuery` on Account, Employee, Vendor and Customer, `transactionQuery` on Bill,
 * Purchase, VendorCredit and JournalEntry — read back and written again, byte for byte. Any
 * other text, an OR among them, a field Intuit does not mark filterable, or an ORDERBY on one
 * it does not mark sortable, is a 400 parser Fault: what Intuit answers there is not
 * documented, and a test that sends one should fail.
 */

/** The entities the simulator holds, where each lives, and which are name lists. */
const ENTITIES: Readonly<
  Record<
    string,
    { readonly rows: (company: SimulatedCompany) => JsonObject[]; readonly list: boolean }
  >
> = {
  Account: { rows: (company) => company.accounts, list: true },
  Employee: { rows: (company) => company.employees, list: true },
  Vendor: { rows: (company) => company.vendors, list: true },
  Customer: { rows: (company) => company.customers, list: true },
  Bill: { rows: (company) => company.bills, list: false },
  Purchase: { rows: (company) => company.purchases, list: false },
  VendorCredit: { rows: (company) => company.vendorCredits, list: false },
  JournalEntry: { rows: (company) => company.journalEntries, list: false },
};

/** Marked `filterable` in Intuit's model file. */
const FILTERABLE: Readonly<Record<string, readonly string[]>> = {
  Account: [
    'Id',
    'Name',
    'SubAccount',
    'ParentRef',
    'Description',
    'Active',
    'Classification',
    'FullyQualifiedName',
    'AccountType',
    'AccountSubType',
    'CurrentBalance',
    'CurrentBalanceWithSubAccounts',
  ],
  Employee: [
    'Id',
    'DisplayName',
    'GivenName',
    'MiddleName',
    'FamilyName',
    'Suffix',
    'PrintOnCheckName',
    'Active',
  ],
  Vendor: [
    'Id',
    'DisplayName',
    'GivenName',
    'MiddleName',
    'FamilyName',
    'Suffix',
    'PrintOnCheckName',
    'CompanyName',
    'Active',
    'Balance',
  ],
  Customer: [
    'Id',
    'DisplayName',
    'GivenName',
    'MiddleName',
    'FamilyName',
    'PrintOnCheckName',
    'CompanyName',
    'FullyQualifiedName',
    'PrimaryEmailAddr',
    'Active',
    'Balance',
  ],
  Bill: [
    'Id',
    'TxnDate',
    'DueDate',
    'DocNumber',
    'TotalAmt',
    'Balance',
    'VendorRef',
    'APAccountRef',
    'SalesTermRef',
  ],
  // Not TotalAmt: sandbox item S4, behind `expenseAmountSearchable`.
  Purchase: ['Id', 'TxnDate', 'DocNumber'],
  VendorCredit: ['Id', 'TxnDate', 'DocNumber', 'TotalAmt', 'APAccountRef'],
  JournalEntry: ['Id', 'TxnDate', 'DocNumber'],
};

/** Marked `sortable` in Intuit's model file, for the transactions a search may order. */
const SORTABLE: Readonly<Record<string, readonly string[]>> = {
  Bill: [
    'TxnDate',
    'DueDate',
    'DocNumber',
    'TotalAmt',
    'VendorRef',
    'APAccountRef',
    'SalesTermRef',
  ],
  Purchase: ['TxnDate', 'DocNumber'],
  VendorCredit: ['TxnDate', 'DocNumber', 'TotalAmt', 'APAccountRef', 'Balance'],
  JournalEntry: ['TxnDate', 'DocNumber'],
};

export interface QueryRules {
  /**
   * Sandbox item S4: whether an expense can be searched by `TotalAmt`. Intuit's model does
   * not mark it filterable, though Intuit's own sample filters on it; off, it is refused.
   */
  readonly expenseAmountSearchable: boolean;
}

/** A condition read back: a builder's, or a name list's `LIKE '%word%'`. */
type Condition =
  QueryCondition | { readonly field: string; readonly operator: 'LIKE'; readonly value: string };

/** A query read back: `Active IN (true, false)` is consumed and not kept — the rebuild writes it. */
interface Parsed {
  readonly entity: string;
  readonly where: Condition[];
  readonly orderBy?: { readonly field: string; readonly descending: boolean };
  readonly maxResults: number;
}

/** The query's words, quoted values and symbols; `undefined` for text no builder writes. */
function tokensOf(text: string): string[] | undefined {
  const tokens: string[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const space = /^ +/u.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const quoted = /^'((?:[^'\\]|\\.)*)'/u.exec(rest);
    if (quoted) {
      tokens.push(`'${quoted[1]!.replace(/\\(.)/gu, '$1')}`);
      at += quoted[0].length;
      continue;
    }
    const piece = /^(?:<=|>=|[=<>(),*]|[A-Za-z0-9]+)/u.exec(rest);
    if (!piece) return undefined;
    tokens.push(piece[0]);
    at += piece[0].length;
  }
  return tokens;
}

/** Reads back the shapes the builders write; the caller then writes it again to compare. */
function parse(text: string): Parsed | undefined {
  const tokens = tokensOf(text);
  if (!tokens) return undefined;
  let at = 0;
  const next = () => tokens[at++];
  const expect = (word: string) => next() === word;
  const value = () => {
    const token = next();
    return token?.startsWith("'") ? token.slice(1) : undefined;
  };
  if (!expect('SELECT') || !expect('*') || !expect('FROM')) return undefined;
  const entity = next();
  if (entity === undefined || !expect('WHERE')) return undefined;
  const where: Condition[] = [];
  for (;;) {
    const field = next();
    const operator = next();
    if (field === undefined || operator === undefined) return undefined;
    if (operator === 'IN') {
      if (!expect('(')) return undefined;
      if (field === 'Active') {
        if (!expect('true') || !expect(',') || !expect('false') || !expect(')')) return undefined;
      } else {
        const values: string[] = [];
        for (;;) {
          const item = value();
          if (item === undefined) return undefined;
          values.push(item);
          const separator = next();
          if (separator === ')') break;
          if (separator !== ',') return undefined;
        }
        where.push({ field, operator: 'IN', values });
      }
    } else if (['=', '<', '>', '<=', '>=', 'LIKE'].includes(operator)) {
      const item = value();
      if (item === undefined) return undefined;
      where.push({ field, operator: operator as '=', value: item });
    } else {
      return undefined;
    }
    if (tokens[at] !== 'AND') break;
    at += 1;
  }
  let orderBy: Parsed['orderBy'];
  if (tokens[at] === 'ORDERBY') {
    at += 1;
    const field = next();
    if (field === undefined) return undefined;
    const descending = tokens[at] === 'DESC';
    if (descending) at += 1;
    orderBy = { field, descending };
  }
  if (!expect('MAXRESULTS')) return undefined;
  const bound = next();
  if (bound === undefined || !/^[1-9][0-9]{0,3}$/u.test(bound) || at !== tokens.length) {
    return undefined;
  }
  return { entity, where, ...(orderBy ? { orderBy } : {}), maxResults: Number(bound) };
}

/**
 * The text the kit's builder writes for this shape — a name list's lookup with its first
 * condition, any other entity's search — or `undefined` when no builder takes it. The caller
 * compares it with the text sent, byte for byte, so whatever the builder would not write is
 * refused there: a lookup without `Active IN (true, false)`, with an order or a second
 * condition, and a search with an Active condition alike.
 */
function rebuilt(parsed: Parsed): string | undefined {
  const { entity, where, orderBy, maxResults } = parsed;
  const holder = ENTITIES[entity];
  if (!holder) return undefined;
  try {
    if (holder.list) {
      const [first] = where;
      if (!first) return undefined;
      if (first.operator === 'LIKE') {
        // The builder writes `%word%`: the word is what lies between the two wildcards.
        const word = /^%(.*)%$/su.exec(first.value)?.[1];
        return word === undefined
          ? undefined
          : lookupLikeQuery(entity, first.field, word, maxResults);
      }
      return first.operator === 'IN'
        ? lookupInQuery(entity, first.field, first.values, maxResults)
        : lookupQuery(entity, first.field, first.value, maxResults);
    }
    // A LIKE on a transaction is no builder's: `transactionQuery` refuses the operator.
    return transactionQuery({
      entity: entity as TransactionEntity,
      where: where as QueryCondition[],
      ...(orderBy ? { orderBy } : {}),
      maxResults,
    });
  } catch {
    return undefined;
  }
}

/** A field's value on a row: a reference (`VendorRef`) by its `value`. */
function fieldOf(row: JsonObject, field: string): unknown {
  const value = row[field];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject).value
    : value;
}

/** `LIKE`: the value's `%` any run of characters, the rest matched as written, without case. */
function likePattern(value: string): RegExp {
  const parts = value.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'isu');
}

/** Intuit compares without case; a number as a number, a date as its `YYYY-MM-DD` text. */
function holds(row: JsonObject, condition: Condition): boolean {
  const actual = fieldOf(row, condition.field);
  if (actual === undefined || actual === null) return false;
  const compare = (wanted: string): number => {
    if (typeof actual === 'number') return actual - Number(wanted);
    const left = String(actual).toLowerCase();
    const right = wanted.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  };
  switch (condition.operator) {
    case 'LIKE':
      return typeof actual === 'string' && likePattern(condition.value).test(actual);
    case 'IN':
      return condition.values.some((wanted) => compare(wanted) === 0);
    case '=':
      return compare(condition.value) === 0;
    case '<':
      return compare(condition.value) < 0;
    case '>':
      return compare(condition.value) > 0;
    case '<=':
      return compare(condition.value) <= 0;
    case '>=':
      return compare(condition.value) >= 0;
  }
}

function sortedBy(rows: JsonObject[], field: string, descending: boolean): JsonObject[] {
  const order = (left: JsonObject, right: JsonObject): number => {
    const [a, b] = [fieldOf(left, field), fieldOf(right, field)];
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const [x, y] = [String(a ?? ''), String(b ?? '')];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const sorted = [...rows].sort(order);
  return descending ? sorted.reverse() : sorted;
}

/** QuickBooks' answer to `query.run` with `text`, from `company`. */
export function answerQuery(
  company: SimulatedCompany,
  text: string,
  rules: QueryRules,
): ProviderAnswer {
  const refused: ProviderAnswer = { status: 400, body: faultAnswer('4000') };
  const parsed = parse(text);
  if (!parsed || rebuilt(parsed) !== text) return refused;
  const filterable = [
    ...(FILTERABLE[parsed.entity] ?? []),
    ...(parsed.entity === 'Purchase' && rules.expenseAmountSearchable ? ['TotalAmt'] : []),
  ];
  if (!parsed.where.every((condition) => filterable.includes(condition.field))) return refused;
  if (parsed.orderBy && !(SORTABLE[parsed.entity] ?? []).includes(parsed.orderBy.field)) {
    return refused;
  }
  const rows = ENTITIES[parsed.entity]!.rows(company).filter((row) =>
    parsed.where.every((condition) => holds(row, condition)),
  );
  const ordered = parsed.orderBy
    ? sortedBy(rows, parsed.orderBy.field, parsed.orderBy.descending)
    : rows;
  return { status: 200, body: queryAnswer(parsed.entity, ordered.slice(0, parsed.maxResults)) };
}
