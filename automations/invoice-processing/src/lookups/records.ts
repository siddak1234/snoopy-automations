import { cleanText, toCents } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type {
  BillRow,
  ExpenseRow,
  FoundRecord,
  JournalEntryRow,
  JournalLine,
  VendorCreditRow,
  VendorState,
} from '../decide/contract.js';

/**
 * QuickBooks' rows, in Intuit's query shapes, as decide's contract types them
 * (`src/decide/contract.ts`): only what decide compares, never a line's text or a memo. A row
 * missing what its type needs — an Id, a date, a total, the vendor or account it names — is no
 * row decide could weigh, and the step that read it fails with the unexpected-answer sentence
 * rather than guess.
 */

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const day = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
/** An amount in whole cents: a fraction of a cent is rounded, the safe side of an equality. */
function cents(value: unknown): number | undefined {
  const reading = toCents(value);
  return reading.kind === 'cents' ? reading.cents : undefined;
}
/** A reference's Id: `{ value, name }`. */
const idOf = (value: unknown): string | undefined =>
  isObject(value) ? text(value.value) : undefined;
const linesOf = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? value.filter((line): line is JsonObject => isObject(line)) : [];

/**
 * The accounts a bill's expense lines name — a credit's category comes from a bill that used one
 * (D25). An item's line names no account, and a line naming one without its Id and name cannot
 * be shown: either makes the accounts unknown (none), so the credit takes the default category.
 */
function lineAccountsOf(value: unknown): BillRow['lineAccounts'] {
  const accounts: { id: string; name: string }[] = [];
  for (const line of linesOf(value)) {
    if (line.DetailType === 'ItemBasedExpenseLineDetail') return [];
    if (line.DetailType !== 'AccountBasedExpenseLineDetail') continue;
    const detail = line.AccountBasedExpenseLineDetail;
    const account = isObject(detail) ? detail.AccountRef : undefined;
    const id = idOf(account);
    const name = isObject(account) ? cleanText(account.name) : null;
    if (id === undefined || name === null) return [];
    accounts.push({ id, name });
  }
  return accounts;
}

export function billOf(row: JsonObject): BillRow | undefined {
  const [id, vendorId, txnDate] = [text(row.Id), idOf(row.VendorRef), day(row.TxnDate)];
  const [totalCents, balanceCents] = [cents(row.TotalAmt), cents(row.Balance)];
  if (!id || !vendorId || !txnDate || totalCents === undefined || balanceCents === undefined) {
    return undefined;
  }
  return {
    kind: 'bill',
    id,
    vendorId,
    docNumber: cleanText(row.DocNumber),
    txnDate,
    totalCents,
    balanceCents,
    lineAccounts: lineAccountsOf(row.Line),
  };
}

export function expenseOf(row: JsonObject): ExpenseRow | undefined {
  const [id, accountId, txnDate, totalCents] = [
    text(row.Id),
    idOf(row.AccountRef),
    day(row.TxnDate),
    cents(row.TotalAmt),
  ];
  if (!id || !accountId || !txnDate || totalCents === undefined) return undefined;
  return {
    kind: 'expense',
    id,
    accountId,
    txnDate,
    totalCents,
    // Absent is an expense; true is a refund to a card ("Credit card credit").
    credit: row.Credit === true,
    docNumber: cleanText(row.DocNumber),
  };
}

export function vendorCreditOf(row: JsonObject): VendorCreditRow | undefined {
  const [id, vendorId, txnDate, totalCents] = [
    text(row.Id),
    idOf(row.VendorRef),
    day(row.TxnDate),
    cents(row.TotalAmt),
  ];
  if (!id || !vendorId || !txnDate || totalCents === undefined) return undefined;
  return {
    kind: 'vendor_credit',
    id,
    vendorId,
    docNumber: cleanText(row.DocNumber),
    txnDate,
    totalCents,
  };
}

const ENTITY_TYPES: ReadonlySet<string> = new Set(['Vendor', 'Employee', 'Customer']);

/** A journal line's Name: `Entity: { Type, EntityRef: { value, name } }`, or none. */
function entityOf(value: unknown): JournalLine['entity'] {
  if (!isObject(value) || typeof value.Type !== 'string' || !ENTITY_TYPES.has(value.Type)) {
    return null;
  }
  const id = idOf(value.EntityRef);
  return id === undefined ? null : { type: value.Type as 'Vendor' | 'Employee' | 'Customer', id };
}

export function journalEntryOf(row: JsonObject): JournalEntryRow | undefined {
  const [id, txnDate] = [text(row.Id), day(row.TxnDate)];
  if (!id || !txnDate) return undefined;
  const lines: JournalLine[] = [];
  for (const line of linesOf(row.Line)) {
    if (line.DetailType !== 'JournalEntryLineDetail') continue;
    const detail: JsonObject = isObject(line.JournalEntryLineDetail)
      ? line.JournalEntryLineDetail
      : {};
    const [amountCents, accountId] = [cents(line.Amount), idOf(detail.AccountRef)];
    const postingType = detail.PostingType;
    if (postingType !== 'Debit' && postingType !== 'Credit') return undefined;
    if (amountCents === undefined || accountId === undefined) return undefined;
    lines.push({ postingType, amountCents, accountId, entity: entityOf(detail.Entity) });
  }
  return { kind: 'journal_entry', id, txnDate, lines };
}

/**
 * QuickBooks' DateTime — an answer's `time` (`2015-07-27T09:09:11.269-07:00`), a row's
 * `MetaData.CreateTime` (`2014-09-17T11:45:45-07:00`) — always with its offset, so it is never read
 * as this machine's local time.
 */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** A QuickBooks DateTime in milliseconds since the epoch; undefined when it is none. */
export function instantOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

/** When QuickBooks created a row — its `MetaData.CreateTime`, by QuickBooks' own clock. */
export function createdAtOf(row: JsonObject): number | undefined {
  return isObject(row.MetaData) ? instantOf(row.MetaData.CreateTime) : undefined;
}

const READERS: Readonly<Record<string, (row: JsonObject) => FoundRecord | undefined>> = {
  Bill: billOf,
  Purchase: expenseOf,
  VendorCredit: vendorCreditOf,
  JournalEntry: journalEntryOf,
};

/** Every row of a search, typed; undefined when one cannot be read. */
export function recordsOf(entity: string, rows: readonly JsonObject[]): FoundRecord[] | undefined {
  const read = READERS[entity];
  if (!read) throw new Error(`${entity} is not a record a lookup reads`);
  const records: FoundRecord[] = [];
  for (const row of rows) {
    const record = read(row);
    if (!record) return undefined;
    records.push(record);
  }
  return records;
}

/**
 * A vendor row matched by name or company name: its Id; its name as QuickBooks shows it; its
 * currency (none set is the home currency, Intuit's Vendor); what QuickBooks shows the company owes
 * it (hold 5, a statement's (d)); its 1099 mark. Undefined without an Id.
 */
export function matchedVendorOf(
  row: JsonObject,
  matchedBy: 'display name' | 'company name',
  searched: string,
): Extract<VendorState, { status: 'matched' }> | undefined {
  const id = text(row.Id);
  if (id === undefined) return undefined;
  const currency = isObject(row.CurrencyRef) ? text(row.CurrencyRef.value) : undefined;
  return {
    status: 'matched',
    id,
    displayName: cleanText(row.DisplayName) ?? searched,
    currency: currency === undefined ? null : currency.toUpperCase(),
    matchedBy,
    balanceCents: cents(row.Balance) ?? null,
    vendor1099: typeof row.Vendor1099 === 'boolean' ? row.Vendor1099 : null,
  };
}
