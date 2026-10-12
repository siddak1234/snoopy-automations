import assert from 'node:assert/strict';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { CheckInput } from '../src/checks/check.js';
import { COMPARED_FIELDS } from '../src/checks/fields.js';
import {
  LOOKUP_KEYS,
  type BillRow,
  type ExpenseRow,
  type FoundRecord,
  type JournalEntryRow,
  type JournalLine,
  type LookupKey,
  type LookupState,
  type NameClash,
  type VendorCreditRow,
  type VendorState,
} from '../src/decide/contract.js';
import { decideRun, type Decision } from '../src/decide/decide.js';
import { requiredLookups } from '../src/decide/lookup-uses.js';
import type { DocumentState, VerificationState } from '../src/state.js';
import { CHECKING, OWNER_EQUITY, TEAM_OWED, VISA, check, documentOf } from './check-world.js';
import { DEFAULT_ACCOUNTS, SEEDED_STATE } from './extract-world.js';

/**
 * decide's world: a whole run state for one path — what every step before decide leaves,
 * Group 4's lookups as the contract (`src/decide/contract.ts`) has them — built from a first
 * read through check-document, so the document is what that step would keep.
 */

export const RUN_ID = '77777777-7777-4777-8777-777777777777';

/** The vendor find-vendor matches by default: the seller of the samples' bills and credits. */
export const VENDOR: Extract<VendorState, { status: 'matched' }> = {
  status: 'matched',
  id: '7',
  displayName: 'Harrowgate Office Supply',
  currency: null,
  matchedBy: 'display name',
  balanceCents: null,
  vendor1099: null,
};

/** The accounts every setting is filled in with. */
export const ACCOUNTS: JsonObject = {
  ...DEFAULT_ACCOUNTS,
  categories: {
    office_supplies: { id: '64', fullyQualifiedName: 'Office Supplies', accountType: 'Expense' },
    meals: { id: '66', fullyQualifiedName: 'Meals', accountType: 'Expense' },
  },
  paidFrom: VISA,
  teamOwed: TEAM_OWED,
  ownerInvestment: OWNER_EQUITY,
  owners: [{ name: 'Pat Owner', account: null }],
};

export interface DecideSetUp {
  /** Read 1's answer, cleaned by check-document. */
  readonly answer: JsonObject;
  readonly check?: Partial<CheckInput>;
  readonly verification?: VerificationState;
  /** The vendor, or null for none found at all (the employee and owner paths). */
  readonly vendor?: VendorState | null;
  readonly lookups?: Partial<Record<LookupKey, LookupState | null>>;
  readonly similarVendors?: readonly string[];
  readonly customerNameClash?: NameClash;
  readonly employeeNameClash?: NameClash;
  readonly preferences?: JsonObject;
  readonly company?: JsonObject;
  readonly accounts?: JsonObject;
  readonly config?: JsonObject;
  /** Changes made to the whole state last. */
  readonly state?: JsonObject;
}

/** A bill QuickBooks holds: open, from the default vendor, unless changed. */
export function billRow(changes: Partial<BillRow> = {}): BillRow {
  return {
    kind: 'bill',
    id: '151',
    vendorId: VENDOR.id,
    docNumber: 'HOS-1042',
    txnDate: '2026-09-14',
    totalCents: 41334,
    balanceCents: 41334,
    lineAccounts: [{ id: '64', name: 'Office Supplies' }],
    ...changes,
  };
}

/** An expense QuickBooks holds: paid from the company card, unless changed. */
export function expenseRow(changes: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    kind: 'expense',
    id: '201',
    accountId: VISA.id,
    txnDate: '2026-09-27',
    totalCents: 6063,
    credit: false,
    docNumber: null,
    ...changes,
  };
}

/** A vendor credit QuickBooks holds, from the default vendor. */
export function vendorCreditRow(changes: Partial<VendorCreditRow> = {}): VendorCreditRow {
  return {
    kind: 'vendor_credit',
    id: '301',
    vendorId: VENDOR.id,
    docNumber: 'CM-0077',
    txnDate: '2026-09-22',
    totalCents: 20320,
    ...changes,
  };
}

/** A journal entry: the cost debited, `credit` cents credited to `accountId` under `entity`. */
export function journalRow(
  credit: number,
  accountId: string,
  changes: Partial<JournalEntryRow> = {},
  entity: JournalLine['entity'] = null,
): JournalEntryRow {
  return {
    kind: 'journal_entry',
    id: '401',
    txnDate: '2026-09-27',
    lines: [
      { postingType: 'Debit', amountCents: credit, accountId: '57', entity: null },
      { postingType: 'Credit', amountCents: credit, accountId, entity },
    ],
    ...changes,
  };
}

/** A lookup that ran and found these records. */
export function found(...records: FoundRecord[]): LookupState {
  return { reachedMax: false, records };
}

/** The second read agreeing on every field the route compares. */
export function agreed(document: DocumentState): Extract<VerificationState, { status: 'made' }> {
  return {
    status: 'made',
    modelServed: 'google/gemini-3.1-flash-lite',
    compared: COMPARED_FIELDS[document.route],
    differences: [],
    totalPicked: null,
    spendTypeDisputed: false,
  };
}

export function decideState(setUp: DecideSetUp): JsonObject {
  const paidFrom = setUp.check && 'paidFrom' in setUp.check ? setUp.check.paidFrom : VISA;
  const document = documentOf(check(setUp.answer, { paidFrom: paidFrom ?? null, ...setUp.check }));
  const personal = document.route === 'employee' || document.route === 'owner';
  const vendor = setUp.vendor === undefined ? (personal ? null : VENDOR) : setUp.vendor;
  const lookups: Partial<Record<LookupKey, LookupState>> = {};
  for (const key of requiredLookups(document.route, document, vendor)) lookups[key] = found();
  for (const key of LOOKUP_KEYS) {
    const given = setUp.lookups?.[key];
    if (given === null) delete lookups[key];
    else if (given !== undefined) lookups[key] = given;
  }
  const newVendorBill = document.route === 'bill' && vendor?.status === 'new';
  const state: JsonObject = {
    ...SEEDED_STATE,
    company: { ...(SEEDED_STATE.company as JsonObject), ...setUp.company },
    preferences: { ...(SEEDED_STATE.preferences as JsonObject), ...setUp.preferences },
    accounts: { ...ACCOUNTS, paidFrom: paidFrom ?? null, ...setUp.accounts },
    modelServed: 'anthropic/claude-haiku-4.5',
    document: document as unknown as JsonObject,
    verification: (setUp.verification ?? agreed(document)) as unknown as JsonObject,
    ...(setUp.check?.payer ? { payer: setUp.check.payer as unknown as JsonObject } : {}),
    ...(vendor === null ? {} : { vendor: vendor as unknown as JsonObject }),
    ...(newVendorBill || setUp.similarVendors
      ? { similarVendors: { names: [...(setUp.similarVendors ?? [])] } }
      : {}),
    ...(newVendorBill || setUp.customerNameClash
      ? { customerNameClash: setUp.customerNameClash ?? 'none' }
      : {}),
    ...(newVendorBill || setUp.employeeNameClash
      ? { employeeNameClash: setUp.employeeNameClash ?? 'none' }
      : {}),
    ...(lookups as unknown as JsonObject),
    ...setUp.state,
  };
  return state;
}

export function decide(setUp: DecideSetUp): Decision {
  return decideRun({
    state: decideState(setUp),
    config: setUp.config ?? { expenseAccount: 'Utilities:Electric' },
    switchOn: setUp.check?.switchOn === true,
  });
}

/** The decision, held: fails the test otherwise. */
export function heldOf(decision: Decision): Extract<Decision, { outcome: 'held' }> {
  assert.equal(decision.outcome, 'held', JSON.stringify(decision).slice(0, 300));
  return decision as Extract<Decision, { outcome: 'held' }>;
}

/** The hold codes a decision carries; [] when it went straight through. */
export function holdCodes(decision: Decision): string[] {
  if (decision.outcome === 'ok') return [];
  return heldOf(decision).holds.map((hold) => hold.code);
}

export { CHECKING, VISA };
