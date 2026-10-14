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
import type { ChartState } from '../src/chart.js';
import type { DocumentState, VerificationState } from '../src/state.js';
import { check, documentOf } from './check-world.js';
import { CHART, SEEDED_STATE } from './extract-world.js';

/**
 * decide's world: a whole run state for one path — what every step before decide leaves, the
 * company's chart the simulator holds, the lookups as the contract (`src/decide/contract.ts`) has
 * them — built from a first read through check-document, so the document is what that step would
 * keep.
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

/** The chart's accounts the suites name. */
export const ACCOUNT = {
  visa: CHART.cards.find((account) => account.id === '41')!,
  visa4417: CHART.cards.find((account) => account.id === '42')!,
  checking: CHART.banks.find((account) => account.id === '35')!,
  savings: CHART.banks.find((account) => account.id === '36')!,
  officeSupplies: CHART.categories.find((account) => account.id === '64')!,
  uncategorized: CHART.uncategorized!,
} as const;

/** The chart with only `ids` among the banks and cards: one of each picks without asking. */
export function chartWith(...ids: string[]): ChartState {
  return {
    ...CHART,
    banks: CHART.banks.filter((account) => ids.includes(account.id)),
    cards: CHART.cards.filter((account) => ids.includes(account.id)),
  };
}

export interface DecideSetUp {
  /** Read 1's answer, cleaned by check-document. */
  readonly answer: JsonObject;
  readonly check?: Partial<CheckInput>;
  readonly verification?: VerificationState;
  readonly vendor?: VendorState;
  readonly lookups?: Partial<Record<LookupKey, LookupState | null>>;
  readonly similarVendors?: readonly string[];
  readonly customerNameClash?: NameClash;
  readonly employeeNameClash?: NameClash;
  readonly preferences?: JsonObject;
  readonly company?: JsonObject;
  /** The company's chart; by default the simulator's, two banks and two cards. */
  readonly chart?: ChartState;
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

/** An expense QuickBooks holds: paid from the card ending 4417, unless changed. */
export function expenseRow(changes: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    kind: 'expense',
    id: '201',
    accountId: '42',
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
  const document = documentOf(check(setUp.answer, setUp.check));
  const vendor = setUp.vendor ?? VENDOR;
  const lookups: Partial<Record<LookupKey, LookupState>> = {};
  for (const key of requiredLookups(document.route, document, vendor)) lookups[key] = found();
  for (const key of LOOKUP_KEYS) {
    const given = setUp.lookups?.[key];
    if (given === null) delete lookups[key];
    else if (given !== undefined) lookups[key] = given;
  }
  const newVendorBill = document.route === 'bill' && vendor.status === 'new';
  const state: JsonObject = {
    ...SEEDED_STATE,
    company: { ...(SEEDED_STATE.company as JsonObject), ...setUp.company },
    preferences: { ...(SEEDED_STATE.preferences as JsonObject), ...setUp.preferences },
    chart: (setUp.chart ?? CHART) as unknown as JsonObject,
    modelServed: 'anthropic/claude-haiku-4.5',
    document: document as unknown as JsonObject,
    verification: (setUp.verification ?? agreed(document)) as unknown as JsonObject,
    vendor: vendor as unknown as JsonObject,
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
  return decideRun({ state: decideState(setUp), config: setUp.config ?? {} });
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
