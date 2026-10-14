import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import { chartStateOf, type ChartState } from '../chart.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import type { CompanyState, DocumentState, PreferencesState, VerificationState } from '../state.js';
import { requiredLookups } from './lookup-uses.js';
import { pickPaidFrom, type PaidFromPick } from './picks.js';

/**
 * decide's whole input (the plan's §2.6 and §5): the run state every step before it leaves — the
 * company, its settings and its chart of accounts, the document as read and checked, then the keys
 * the lookups write, which this file is the contract of. decide reads nothing else, and a key it needs that is missing or malformed fails the run
 * ("could not finish its checks") rather than guess (ip-review design-checks-rules-and-approval.json,
 * cross_cutting[10]).
 *
 * A lookup that does not apply is SKIPPED, and a skipped step writes no state (the SDK's runner),
 * so its key is absent; one that applies but has nothing it could search for — no number QuickBooks
 * could hold (Group 4's G4-4) — says "Not checked" on its line and writes none either. `lookupUses`
 * (`lookup-uses.ts`) says which, per route, for the steps and for decide alike, so the two cannot
 * drift apart.
 */

/** find-vendor, then find-vendor-company: the supplier or seller. */
export type VendorState =
  | {
      readonly status: 'matched';
      readonly id: string;
      /** As QuickBooks shows it. */
      readonly displayName: string;
      /** Its CurrencyRef; null when QuickBooks gave none, which is the home currency (Intuit's Vendor). */
      readonly currency: string | null;
      readonly matchedBy: 'display name' | 'company name';
      /** `Vendor.Balance` in whole cents: what QuickBooks shows the company owes it (hold 5; a statement's (d)). */
      readonly balanceCents: number | null;
      /** `Vendor.Vendor1099`: marked a 1099 contractor; null when QuickBooks does not say. */
      readonly vendor1099: boolean | null;
    }
  /** No active vendor by that name, then by company name. */
  | { readonly status: 'new' }
  /**
   * A company receipt's or a card refund's seller whose name an inactive vendor has, or two
   * vendors have: the seller is looked up only to link an existing vendor (D20), so it is not
   * linked — no payee, the seller in the memo and the line text — where a bill, a credit note or
   * a statement is not recorded.
   */
  | {
      readonly status: 'not_linked';
      readonly reason: 'inactive' | 'ambiguous';
      readonly matchedBy: 'display name' | 'company name';
    };

/** find-similar-vendors: names close to a new vendor's, counted on the line only. */
export interface SimilarVendorsState {
  readonly names: readonly string[];
}

/** find-customer-name and find-employee-name: whether a customer or an employee has a new vendor's name. */
export type NameClash = 'match' | 'none' | 'unreadable';

/** A bill a lookup found. */
export interface BillRow {
  readonly kind: 'bill';
  readonly id: string;
  readonly vendorId: string;
  readonly docNumber: string | null;
  readonly txnDate: string;
  readonly totalCents: number;
  /** 0 when fully paid ("A Balance of 0 indicates the bill is fully paid"). */
  readonly balanceCents: number;
  /** The accounts on its expense lines: a credit note's category comes from a bill that used one (D25). */
  readonly lineAccounts: readonly { readonly id: string; readonly name: string }[];
}

/** An expense (Intuit's Purchase) a lookup found. */
export interface ExpenseRow {
  readonly kind: 'expense';
  readonly id: string;
  /** Its `AccountRef`: the bank or card account it was paid from. */
  readonly accountId: string;
  readonly txnDate: string;
  readonly totalCents: number;
  /** A refund to a card ("Credit card credit"). */
  readonly credit: boolean;
  readonly docNumber: string | null;
}

/** A vendor credit a lookup found. */
export interface VendorCreditRow {
  readonly kind: 'vendor_credit';
  readonly id: string;
  readonly vendorId: string;
  readonly docNumber: string | null;
  readonly txnDate: string;
  readonly totalCents: number;
}

/** One line of a journal entry, as the code compares lines (its `TotalAmt` is always 0). */
export interface JournalLine {
  readonly postingType: 'Debit' | 'Credit';
  readonly amountCents: number;
  readonly accountId: string;
  /** The line's Name: a vendor, an employee or a customer, or none. */
  readonly entity: {
    readonly type: 'Vendor' | 'Employee' | 'Customer';
    readonly id: string;
  } | null;
}

/** A journal entry a lookup found. */
export interface JournalEntryRow {
  readonly kind: 'journal_entry';
  readonly id: string;
  readonly txnDate: string;
  readonly lines: readonly JournalLine[];
}

export type FoundRecord = BillRow | ExpenseRow | VendorCreditRow | JournalEntryRow;

/**
 * One duplicate lookup — find-duplicate-number, find-duplicate-amount, find-related,
 * find-other-record — each its query per route (the plan's §5), its rows as found. decide does
 * every comparison the plan leaves to code: the vendor, the account, the window, the lines.
 */
export interface LookupState {
  /** The answer reached its MAXRESULTS: more may be unseen, which counts as a possible duplicate (D6). */
  readonly reachedMax: boolean;
  readonly records: readonly FoundRecord[];
  /**
   * QuickBooks' own clock when it answered (the answer's `time`), which the re-check after an
   * approval holds a record's creation against (`recheck.ts`); absent or null when it gave none.
   */
  readonly answeredAt?: string | null;
}

/** The lookups by their state keys. */
export const LOOKUP_KEYS = [
  'numberLookup',
  'amountLookup',
  'relatedLookup',
  'otherRecordLookup',
] as const;
export type LookupKey = (typeof LOOKUP_KEYS)[number];

/** What decide reads. */
export interface DecideState {
  readonly file: { readonly artifactId: string };
  readonly company: CompanyState;
  readonly preferences: PreferencesState;
  /** find-accounts' chart, which decide picks from (`picks.ts`). */
  readonly chart: ChartState;
  /**
   * What a company receipt or a card refund was paid from, picked from the chart (decision 1):
   * read here once, so the duplicate rule, the holds and the plan see the same pick; null on a route
   * paid from nothing.
   */
  readonly paidFrom: PaidFromPick | null;
  /** The model that served the first read. */
  readonly modelServed: string;
  readonly document: DocumentState;
  /** `{ status: 'not_needed' }` when verify-read was not due, and so wrote nothing. */
  readonly verification: VerificationState;
  readonly vendor: VendorState;
  readonly similarVendors: SimilarVendorsState | null;
  readonly customerNameClash: NameClash | null;
  readonly employeeNameClash: NameClash | null;
  readonly numberLookup: LookupState | null;
  readonly amountLookup: LookupState | null;
  readonly relatedLookup: LookupState | null;
  readonly otherRecordLookup: LookupState | null;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);

function isRecord(value: unknown): value is FoundRecord {
  if (!isObject(value) || !isText(value.id) || !isDay(value.txnDate)) return false;
  switch (value.kind) {
    case 'bill':
      return (
        isText(value.vendorId) &&
        isCents(value.totalCents) &&
        isCents(value.balanceCents) &&
        Array.isArray(value.lineAccounts) &&
        value.lineAccounts.every(
          (account) => isObject(account) && isText(account.id) && isText(account.name),
        ) &&
        (value.docNumber === null || typeof value.docNumber === 'string')
      );
    case 'expense':
      return (
        isText(value.accountId) &&
        isCents(value.totalCents) &&
        typeof value.credit === 'boolean' &&
        (value.docNumber === null || typeof value.docNumber === 'string')
      );
    case 'vendor_credit':
      return (
        isText(value.vendorId) &&
        isCents(value.totalCents) &&
        (value.docNumber === null || typeof value.docNumber === 'string')
      );
    case 'journal_entry':
      return (
        Array.isArray(value.lines) &&
        value.lines.every(
          (line) =>
            isObject(line) &&
            (line.postingType === 'Debit' || line.postingType === 'Credit') &&
            isCents(line.amountCents) &&
            isText(line.accountId) &&
            (line.entity === null || (isObject(line.entity) && isText(line.entity.id))),
        )
      );
    default:
      return false;
  }
}

function lookupOf(value: unknown): LookupState | null | undefined {
  if (value === undefined) return null;
  if (!isObject(value) || typeof value.reachedMax !== 'boolean' || !Array.isArray(value.records)) {
    return undefined;
  }
  const { answeredAt } = value;
  if (answeredAt !== undefined && answeredAt !== null && !isText(answeredAt)) return undefined;
  return value.records.every(isRecord) ? (value as unknown as LookupState) : undefined;
}

/** `state.vendor` as find-vendor writes it: null when absent, undefined when malformed. */
export function vendorOf(value: unknown): VendorState | null | undefined {
  if (value === undefined) return null;
  if (!isObject(value)) return undefined;
  if (value.status === 'new') return { status: 'new' };
  if (value.status === 'not_linked') {
    const { reason, matchedBy } = value;
    return (reason === 'inactive' || reason === 'ambiguous') &&
      (matchedBy === 'display name' || matchedBy === 'company name')
      ? { status: 'not_linked', reason, matchedBy }
      : undefined;
  }
  if (
    value.status !== 'matched' ||
    !isText(value.id) ||
    !isText(value.displayName) ||
    (value.currency !== null && typeof value.currency !== 'string') ||
    (value.balanceCents !== null && !isCents(value.balanceCents)) ||
    (value.vendor1099 !== null && typeof value.vendor1099 !== 'boolean')
  ) {
    return undefined;
  }
  return value as unknown as VendorState;
}

function clashOf(value: unknown): NameClash | null | undefined {
  if (value === undefined) return null;
  return value === 'match' || value === 'none' || value === 'unreadable' ? value : undefined;
}

/**
 * The state as decide reads it, or undefined when a record it needs is missing or malformed: the
 * earlier steps' keys, the vendor on every route that has one, the name checks for a new vendor's
 * bill, and each lookup the route requires under `expenseSearch` (S4) — "state incomplete", never
 * a guess.
 */
export function readDecideState(
  state: JsonObject,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): DecideState | undefined {
  const { file, company, preferences, document, modelServed } = state;
  const chart = chartStateOf(state.chart);
  // verify-read writes nothing when it is not due: no second read was needed.
  const verification = state.verification ?? { status: 'not_needed' };
  if (
    !isObject(file) ||
    !isText(file.artifactId) ||
    !isObject(company) ||
    !isText(company.name) ||
    !isObject(preferences) ||
    !isText(preferences.homeCurrency) ||
    typeof preferences.multiCurrencyEnabled !== 'boolean' ||
    !chart ||
    !isObject(document) ||
    typeof document.route !== 'string' ||
    !isObject(document.arithmetic) ||
    !isObject(verification) ||
    !['made', 'not_made', 'not_needed'].includes(String(verification.status)) ||
    !isText(modelServed)
  ) {
    return undefined;
  }
  const doc = document as unknown as DocumentState;
  const vendor = vendorOf(state.vendor);
  const similar = state.similarVendors;
  const customer = clashOf(state.customerNameClash);
  const employee = clashOf(state.employeeNameClash);
  const lookups = Object.fromEntries(
    LOOKUP_KEYS.map((key) => [key, lookupOf(state[key])]),
  ) as Record<LookupKey, LookupState | null | undefined>;
  if (vendor === undefined || customer === undefined || employee === undefined) return undefined;
  if (Object.values(lookups).some((lookup) => lookup === undefined)) return undefined;
  if (vendor === null) return undefined;
  // A seller left unlinked is a company receipt's or a card refund's alone (D20).
  const linkOnly = doc.route === 'company_receipt' || doc.route === 'card_refund';
  if (vendor.status === 'not_linked' && !linkOnly) return undefined;
  const newVendorBill = doc.route === 'bill' && vendor.status === 'new';
  const similarVendors =
    isObject(similar) && Array.isArray(similar.names) && similar.names.every(isText)
      ? (similar as unknown as SimilarVendorsState)
      : null;
  if (newVendorBill && (customer === null || employee === null)) return undefined;
  for (const key of requiredLookups(doc.route, doc, vendor, expenseSearch)) {
    if (lookups[key] === null) return undefined;
  }
  return {
    file: { artifactId: file.artifactId },
    company: company as unknown as CompanyState,
    preferences: preferences as unknown as PreferencesState,
    chart,
    paidFrom: linkOnly ? pickPaidFrom(chart, doc) : null,
    modelServed,
    document: doc,
    verification: verification as unknown as VerificationState,
    vendor,
    similarVendors,
    customerNameClash: customer,
    employeeNameClash: employee,
    numberLookup: lookups.numberLookup ?? null,
    amountLookup: lookups.amountLookup ?? null,
    relatedLookup: lookups.relatedLookup ?? null,
    otherRecordLookup: lookups.otherRecordLookup ?? null,
  };
}
