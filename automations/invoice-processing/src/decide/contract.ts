import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type { Route } from '../document.js';
import type {
  AccountsState,
  CompanyState,
  DocumentState,
  PayerState,
  PreferencesState,
  VerificationState,
} from '../state.js';

/**
 * decide's whole input (the plan's §2.6 and §5): the run state every step before it leaves. The
 * keys up to `verification` are written today; the rest are written by Group 4's lookups (steps
 * 9–17, not yet approved), and this file is the contract they adopt. decide reads nothing else,
 * and a key it needs that is missing or malformed fails the run ("could not finish its checks")
 * rather than guess (ip-review design-checks-rules-and-approval.json, cross_cutting[10]).
 *
 * A lookup that does not apply is SKIPPED, and a skipped step writes no state (the SDK's runner),
 * so its key is absent; `REQUIRED_LOOKUPS` says, per route, which must have run.
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
 * The lookups each route needs to have run, from what the document and the vendor are (the
 * plan's §5): a number lookup only for a number QuickBooks could hold (1–21 characters; Group 4's
 * G4-4) — a receipt's only for a seller already a vendor; a related lookup for a bill's number, a
 * credit's original invoice, a receipt and a payer; the other-record lookup (D32) for a bill and
 * a company receipt; a statement's number lookup only when it lists invoices.
 */
export function requiredLookups(
  route: Route,
  document: DocumentState,
  vendor: VendorState | null,
): readonly LookupKey[] {
  const linked = vendor?.status === 'matched';
  const numbered = document.numberUsable;
  const original = document.originalInvoiceNumber !== null;
  const required: LookupKey[] = ['amountLookup'];
  switch (route) {
    case 'bill':
      if (numbered) required.push('numberLookup', 'relatedLookup');
      required.push('otherRecordLookup');
      break;
    case 'company_receipt':
      if (numbered && linked) required.push('numberLookup');
      required.push('relatedLookup', 'otherRecordLookup');
      break;
    case 'card_refund':
      if (numbered) required.push('numberLookup');
      if (linked && original) required.push('relatedLookup');
      break;
    case 'vendor_credit':
      if (numbered) required.push('numberLookup');
      if (original) required.push('relatedLookup');
      break;
    case 'employee':
    case 'owner':
    case 'contractor':
      if (numbered && document.type === 'bill') required.push('numberLookup');
      required.push('relatedLookup');
      break;
    case 'statement':
      if ((document.statement?.rows ?? []).some((row) => row.kind === 'invoice')) {
        required.push('numberLookup');
      }
      break;
  }
  return required;
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

function vendorOf(value: unknown): VendorState | null | undefined {
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
 * bill, and each lookup the route requires — "state incomplete", never a guess.
 */
export function readDecideState(state: JsonObject): DecideState | undefined {
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
  for (const key of requiredLookups(doc.route, doc, vendor)) {
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
