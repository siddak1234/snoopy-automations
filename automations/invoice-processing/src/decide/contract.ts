import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type { Route } from '../document.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import type {
  AccountsState,
  CompanyState,
  DocumentState,
  PayerState,
  PreferencesState,
  VerificationState,
} from '../state.js';

/**
 * decide's whole input (the plan's §2.6 and §5): the run state every step before it leaves — steps
 * 1–8's keys, then the keys Group 4's lookups (steps 9–17) write, which this file is the contract
 * of. decide reads nothing else, and a key it needs that is missing or malformed fails the run
 * ("could not finish its checks") rather than guess (ip-review design-checks-rules-and-approval.json,
 * cross_cutting[10]).
 *
 * A lookup that does not apply is SKIPPED, and a skipped step writes no state (the SDK's runner),
 * so its key is absent; one that applies but has nothing it could search for — no number QuickBooks
 * could hold (Group 4's G4-4) — says "Not checked" on its line and writes none either. `lookupUses`
 * says which, per route, for the steps and for decide alike, so the two cannot drift apart.
 */

/** find-vendor, then find-vendor-company: the supplier or seller — or, for a contractor, the person who paid. */
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
  | { readonly status: 'new' };

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
  readonly accounts: AccountsState;
  readonly payer: PayerState | null;
  /** The model that served the first read. */
  readonly modelServed: string;
  readonly document: DocumentState;
  readonly verification: VerificationState;
  /** Absent on the employee and owner routes, which have no vendor. */
  readonly vendor: VendorState | null;
  readonly similarVendors: SimilarVendorsState | null;
  readonly customerNameClash: NameClash | null;
  readonly employeeNameClash: NameClash | null;
  readonly numberLookup: LookupState | null;
  readonly amountLookup: LookupState | null;
  readonly relatedLookup: LookupState | null;
  readonly otherRecordLookup: LookupState | null;
}

/**
 * How a lookup step meets a document: it runs its query and writes its key; it applies, but there
 * is no number QuickBooks could hold to search for (none read, or over 21 characters: G4-4), so its
 * line says "Not checked" and it writes nothing; or it does not apply — skipped, no line.
 */
export type LookupUse = 'run' | 'not_checked' | 'skip';

/**
 * Each lookup's use per route, from what the document and the vendor are (the plan's §5):
 * - a number lookup only for a number QuickBooks could hold — a receipt's only for a seller already
 *   a vendor, a purchase paid personally only for a bill document, a statement's only when it lists
 *   invoices;
 * - an amount lookup on every route;
 * - a related lookup for a bill's number, a receipt, a payer, and a credit's original invoice
 *   number — whatever its length, which simply finds nothing past 21 characters — from a linked
 *   vendor;
 * - the other-record lookup (D32) for a bill — only while expenses are searched by amount (S4's
 *   fallback drops it) — and for a company receipt;
 * - nothing at all for a vendor credit or a statement whose vendor is not in QuickBooks: their
 *   lookups need the vendor, and decide fails them (F5, F6).
 */
export function lookupUses(
  route: Route,
  document: DocumentState,
  vendor: VendorState | null,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): Readonly<Record<LookupKey, LookupUse>> {
  const linked = vendor?.status === 'matched';
  const byNumber: LookupUse = document.numberUsable ? 'run' : 'not_checked';
  const when = (applies: boolean, use: LookupUse = 'run'): LookupUse => (applies ? use : 'skip');
  const uses = (
    numberLookup: LookupUse,
    relatedLookup: LookupUse,
    otherRecordLookup: LookupUse = 'skip',
  ) => ({ numberLookup, amountLookup: 'run' as const, relatedLookup, otherRecordLookup });
  switch (route) {
    case 'bill':
      return uses(byNumber, byNumber, when(expenseSearch === 'amount'));
    case 'company_receipt':
      return uses(when(linked, byNumber), 'run', 'run');
    case 'card_refund':
      return uses(byNumber, when(linked && document.originalInvoiceNumber !== null));
    case 'employee':
    case 'owner':
    case 'contractor':
      return uses(when(document.type === 'bill', byNumber), 'run');
    case 'vendor_credit':
    case 'statement': {
      if (!linked) {
        return {
          numberLookup: 'skip',
          amountLookup: 'skip',
          relatedLookup: 'skip',
          otherRecordLookup: 'skip',
        };
      }
      return route === 'statement'
        ? uses(when((document.statement?.rows ?? []).some((row) => row.kind === 'invoice')), 'skip')
        : uses(byNumber, when(document.originalInvoiceNumber !== null));
    }
  }
}

/** The lookups a route needs to have run — its `lookupUses` that run — amount first. */
export function requiredLookups(
  route: Route,
  document: DocumentState,
  vendor: VendorState | null,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): readonly LookupKey[] {
  const uses = lookupUses(route, document, vendor, expenseSearch);
  const order: readonly LookupKey[] = [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
    'otherRecordLookup',
  ];
  return order.filter((key) => uses[key] === 'run');
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
  return value.records.every(isRecord) ? (value as unknown as LookupState) : undefined;
}

/** `state.vendor` as find-vendor writes it: null when absent, undefined when malformed. */
export function vendorOf(value: unknown): VendorState | null | undefined {
  if (value === undefined) return null;
  if (!isObject(value)) return undefined;
  if (value.status === 'new') return { status: 'new' };
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
  const { file, company, preferences, accounts, document, verification, modelServed } = state;
  if (
    !isObject(file) ||
    !isText(file.artifactId) ||
    !isObject(company) ||
    !isText(company.name) ||
    !isObject(preferences) ||
    !isText(preferences.homeCurrency) ||
    typeof preferences.multiCurrencyEnabled !== 'boolean' ||
    !isObject(accounts) ||
    !isObject(accounts.defaultCategory) ||
    !isObject(accounts.categories) ||
    !Array.isArray(accounts.owners) ||
    !isObject(document) ||
    typeof document.route !== 'string' ||
    !isObject(document.arithmetic) ||
    !isObject(verification) ||
    (verification.status !== 'made' && verification.status !== 'not_made') ||
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
  const personal = doc.route === 'employee' || doc.route === 'owner';
  if (personal ? vendor !== null : vendor === null) return undefined;
  if (doc.route === 'contractor' && vendor?.status !== 'matched') return undefined;
  // A route that records who paid needs find-payer's answer.
  const paidPersonally = personal || doc.route === 'contractor';
  if (paidPersonally && !isObject(state.payer)) return undefined;
  const newVendorBill = doc.route === 'bill' && vendor?.status === 'new';
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
    accounts: accounts as unknown as AccountsState,
    payer: isObject(state.payer) ? (state.payer as unknown as PayerState) : null,
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
