import {
  dateRange,
  lookupLikeQuery,
  lookupQuery,
  transactionQuery,
  type QueryCondition,
  type TransactionEntity,
} from '@autom8x/automation-kit/quickbooks';
import { addDays, queryAmount } from '@autom8x/automation-kit/values';

import type { VendorState } from '../decide/contract.js';
import { FEED_WINDOW } from '../decide/matches.js';
import type { DocumentState } from '../state.js';
import type { ExpenseSearch } from './expense-search.js';

/**
 * Every QuickBooks query the lookups (steps 9–17) send, built here and nowhere else, so a fixed-text
 * test holds each one (ip-review design-quickbooks-lookups.json cross_cutting[0], as the plan's §5
 * table runs each lookup per document type). One `query.run` per step: the platform refuses a
 * second, different request under a step's one key with 409, so nothing pages. Intuit's language:
 * IN, =, <, >, <=, >= and LIKE, joined by AND, never OR; a value quoted by the kit (a backslash
 * doubled, then an apostrophe escaped); `Active IN (true, false)` on a name list — vendors,
 * customers, employees — and never on a transaction; an amount from whole cents (`1250.00`).
 */

/**
 * The most rows each lookup asks for. An answer that reaches its bound sets `reachedMax`: more may
 * be unseen, which decide counts as a possible duplicate (D6). Each answer must also fit the 192 KiB
 * Connections allows (snoopy-backend apps/connections/src/operations.ts:39) — a larger one fails
 * the run after the SDK's repeats — so the bounds that pass the design's 3 are sized by the rows
 * Intuit's own query samples return (compact JSON: a Purchase of one line 854–931 bytes, of four
 * 1,865; a Bill of one or two lines 576–892; a JournalEntry of two lines 660–669).
 */
export const MAX_RESULTS = {
  /** Two vendors tell one from two. */
  vendor: 2,
  /** One customer or employee is enough to know the name is taken. */
  nameClash: 1,
  /** Three similar names for the approver, then "maybe more". */
  similar: 3,
  /** Bills, expenses and vendor credits by number or amount: enough Ids for the approver and the re-check after approval. */
  records: 3,
  /**
   * Journal entries on a day, or in the bank-feed window — their `TotalAmt` is always 0, so lines
   * are compared in code: 10 rows of up to 19.6 KB each, a journal entry of some 75 lines.
   * PROVISIONAL, a trade-off owed a measured answer size or the owner's choice before v1 freezes:
   * a company receipt whose 22-day window holds 10 entries of any kind — the reimbursements this
   * automation records among them — is held "too many to check" (D6), and a larger bound lets
   * larger entries make an answer over 192 KiB, which fails the run.
   */
  journalEntries: 10,
  /**
   * S4's fallback: expenses in the window, newest first, as many as fit — 50 rows of up to 3.9 KB
   * each, twice the four-line sample, so a page of ordinary expenses never nears the bound.
   */
  windowExpenses: 50,
  /** A statement's vendor's open bills: 40, like its rows — 4.9 KB a bill, some 14 lines each. */
  openBills: 40,
} as const;

/** A search of one kind of transaction, its text and its bound. */
export interface Search {
  readonly entity: TransactionEntity;
  readonly query: string;
  readonly maxResults: number;
}

const equals = (field: string, value: string): QueryCondition => ({ field, operator: '=', value });

function search(
  entity: TransactionEntity,
  where: QueryCondition[],
  maxResults: number,
  newestFirst = false,
): Search {
  const orderBy = newestFirst ? { orderBy: { field: 'TxnDate', descending: true } } : {};
  return { entity, maxResults, query: transactionQuery({ entity, where, ...orderBy, maxResults }) };
}

/** A vendor by the exact name printed, or typed in "Who paid": `SELECT * FROM Vendor WHERE DisplayName = '…' AND Active IN (true, false) MAXRESULTS 2`. */
export const vendorByName = (name: string) =>
  lookupQuery('Vendor', 'DisplayName', name, MAX_RESULTS.vendor);

/** A vendor whose company name is that name. */
export const vendorByCompanyName = (name: string) =>
  lookupQuery('Vendor', 'CompanyName', name, MAX_RESULTS.vendor);

/** Vendors with the word in their name, inactive ones included (Group 4's G4-2). */
export const similarVendorsQuery = (word: string) =>
  lookupLikeQuery('Vendor', 'DisplayName', word, MAX_RESULTS.similar);

/** A customer with a new vendor's name. */
export const customerByName = (name: string) =>
  lookupQuery('Customer', 'DisplayName', name, MAX_RESULTS.nameClash);

/** An employee with a new vendor's name. */
export const employeeByName = (name: string) =>
  lookupQuery('Employee', 'DisplayName', name, MAX_RESULTS.nameClash);

/** The bank-feed window around a date (D21): from 1 day before it to 20 days after, both included. */
export function feedWindow(date: string): { readonly from: string; readonly to: string } {
  return { from: addDays(date, -FEED_WINDOW.before), to: addDays(date, FEED_WINDOW.after) };
}

/** Expenses of an amount in the feed window (D21) — or, under S4's fallback, the window alone, newest first. */
export function feedExpenses(amountCents: number, date: string, how: ExpenseSearch): Search {
  const { from, to } = feedWindow(date);
  const window = dateRange('TxnDate', from, to);
  return how === 'amount'
    ? search(
        'Purchase',
        [equals('TotalAmt', queryAmount(amountCents)), ...window],
        MAX_RESULTS.records,
      )
    : search('Purchase', window, MAX_RESULTS.windowExpenses, true);
}

/** The vendor's Id, which every lookup that names the vendor is only run with (`lookupUses`). */
function vendorIdOf(vendor: VendorState | null): string {
  if (vendor?.status !== 'matched')
    throw new Error('a lookup that names the vendor ran without one');
  return vendor.id;
}

/** The invoice numbers a statement lists, each once: Intuit compares without case, and IN refuses a repeat. */
export function listedInvoiceNumbers(document: DocumentState): string[] {
  const numbers = new Map<string, string>();
  for (const row of document.statement?.rows ?? []) {
    const folded = row.reference.toLowerCase();
    if (row.kind === 'invoice' && !numbers.has(folded)) numbers.set(folded, row.reference);
  }
  return [...numbers.values()];
}

/** find-duplicate-number's search per route (§5): by the document's number, or a statement's listed numbers. */
export function numberSearch(document: DocumentState, vendor: VendorState | null): Search {
  const number = document.number ?? '';
  switch (document.route) {
    case 'company_receipt':
      // A bill from the linked seller with this number, open or paid: an invoice stamped PAID.
      return search(
        'Bill',
        [equals('DocNumber', number), equals('VendorRef', vendorIdOf(vendor))],
        MAX_RESULTS.records,
      );
    case 'card_refund':
    case 'vendor_credit':
      // VendorRef cannot be searched on a vendor credit: decide compares the vendor.
      return search('VendorCredit', [equals('DocNumber', number)], MAX_RESULTS.records);
    case 'statement': {
      // One more row than numbers: a full answer means a number on two bills, and more unseen.
      const numbers = listedInvoiceNumbers(document);
      return search(
        'Bill',
        [
          { field: 'DocNumber', operator: 'IN', values: numbers },
          equals('VendorRef', vendorIdOf(vendor)),
        ],
        numbers.length + 1,
      );
    }
    default:
      // A bill, and a bill document someone paid personally: any vendor's bill with the number.
      return search('Bill', [equals('DocNumber', number)], MAX_RESULTS.records);
  }
}

/** find-duplicate-amount's search per route (§5), including the bank-feed check (D21). */
export function amountSearch(
  document: DocumentState,
  vendor: VendorState | null,
  how: ExpenseSearch,
): Search {
  const amount = queryAmount(document.amountCents ?? 0);
  const date = document.date ?? '';
  switch (document.route) {
    case 'bill':
    case 'contractor': {
      // The vendor's own bills when it is matched; any vendor's for a new one. A contractor is always matched.
      const where = [equals('TotalAmt', amount), equals('TxnDate', date)];
      if (vendor?.status === 'matched') where.push(equals('VendorRef', vendor.id));
      return search('Bill', where, MAX_RESULTS.records);
    }
    case 'company_receipt':
    case 'card_refund':
      return feedExpenses(document.amountCents ?? 0, date, how);
    case 'employee':
    case 'owner':
      return search('JournalEntry', [equals('TxnDate', date)], MAX_RESULTS.journalEntries);
    case 'vendor_credit':
      return search(
        'VendorCredit',
        [equals('TotalAmt', amount), equals('TxnDate', date)],
        MAX_RESULTS.records,
      );
    case 'statement':
      return search(
        'Bill',
        [
          { field: 'Balance', operator: '>', value: queryAmount(0) },
          equals('VendorRef', vendorIdOf(vendor)),
        ],
        MAX_RESULTS.openBills,
      );
  }
}

/** find-related's search per route (§5). */
export function relatedSearch(
  document: DocumentState,
  vendor: VendorState | null,
  how: ExpenseSearch,
): Search {
  const date = document.date ?? '';
  switch (document.route) {
    case 'bill':
      // Decision 6: an expense already entered with this number, whoever the payee (G4-5).
      return search('Purchase', [equals('DocNumber', document.number ?? '')], MAX_RESULTS.records);
    case 'company_receipt':
      // A bill for this total from any vendor, any balance, newest first (hold 6, D22).
      return search(
        'Bill',
        [equals('TotalAmt', queryAmount(document.amountCents ?? 0))],
        MAX_RESULTS.records,
        true,
      );
    case 'card_refund':
    case 'vendor_credit':
      // The original bill, for its category (D25) — even a number too long for one: it finds nothing.
      return search(
        'Bill',
        [
          equals('DocNumber', document.originalInvoiceNumber ?? ''),
          equals('VendorRef', vendorIdOf(vendor)),
        ],
        MAX_RESULTS.records,
      );
    case 'employee':
    case 'owner':
    case 'contractor':
      // Hold 7: a company bank or card charge for what the person paid.
      return feedExpenses(document.amountCents ?? 0, date, how);
    case 'statement':
      throw new Error('a statement has no related lookup');
  }
}

/** find-other-record's search (D32): a bill's expense for its total, or a receipt's reimbursement. */
export function otherRecordSearch(document: DocumentState): Search {
  const date = document.date ?? '';
  if (document.route === 'bill') {
    // From 1 day before the bill's date to 20 days after its due date, or its date when it has none.
    const until = addDays(document.dueDate ?? date, FEED_WINDOW.after);
    return search(
      'Purchase',
      [
        equals('TotalAmt', queryAmount(document.amountCents ?? 0)),
        ...dateRange('TxnDate', addDays(date, -FEED_WINDOW.before), until),
      ],
      MAX_RESULTS.records,
    );
  }
  const { from, to } = feedWindow(date);
  return search('JournalEntry', dateRange('TxnDate', from, to), MAX_RESULTS.journalEntries);
}
