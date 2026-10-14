import { MAXIMUM_NAME_LENGTH } from '@autom8x/automation-kit/values';

import type { Route } from '../document.js';
import type { NotRecordedReason } from '../quickbooks-path.js';
import type { DecideState } from './contract.js';

/**
 * decide's rules (the plan's §2.3, F1–F7, and §2.6 per path): QuickBooks' own data rules the record
 * out, so a hold would ask a person to approve something that cannot be created — or, for a
 * statement, would hide a bill that may never be recorded (F7). The first that applies wins, before
 * any hold is weighed. In v2 none fails the run (the spec's S2): the document is "not recorded in
 * QuickBooks", and its details are saved.
 */

export type FailRule = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7';

/** Each rule's reason, as "Not recorded in QuickBooks: …" says it (§3.F). */
export const DECIDE_REASONS: Readonly<Record<FailRule, NotRecordedReason>> = {
  F1: 'not_usd',
  F2: 'vendor_currency',
  F3: 'closed_books',
  F4: 'vendor_name_too_long',
  F5: 'credit_needs_vendor',
  F6: 'vendor_not_in_quickbooks',
  F7: 'reads_disagree_type',
};

/**
 * The rules each path checks, in order (the plan's §2.6), except that a statement checks F7 before
 * F6 (the owner's decision of 2026-10-12): a first-time bill titled "Statement" that the two reads
 * dispute says the reads disagree on the type, not that the vendor is missing.
 */
export const PATH_FAILS: Readonly<Record<Route, readonly FailRule[]>> = {
  bill: ['F1', 'F2', 'F3', 'F4'],
  company_receipt: ['F1', 'F2', 'F3'],
  card_refund: ['F1', 'F2', 'F3'],
  vendor_credit: ['F1', 'F2', 'F3', 'F5'],
  statement: ['F1', 'F2', 'F7', 'F6'],
};

/** The name a new vendor is created with: as printed, or "<name> (vendor)" when a customer or employee has it. */
export function newVendorName(state: DecideState): {
  name: string;
  inUseBy: 'customer' | 'employee' | null;
} {
  const inUseBy =
    state.customerNameClash === 'match'
      ? 'customer'
      : state.employeeNameClash === 'match'
        ? 'employee'
        : null;
  const printed = state.document.seller;
  return { name: inUseBy === null ? printed : `${printed} (vendor)`, inUseBy };
}

const RULES: Readonly<Record<FailRule, (state: DecideState) => boolean>> = {
  // A recognised printed code other than USD (the company is a US company, read-company).
  F1: ({ document }) => document.currency !== null && document.currency !== 'USD',
  // A linked vendor's currency; none set is the home currency (Intuit's Vendor).
  F2: ({ vendor, preferences }) =>
    vendor.status === 'matched' && (vendor.currency ?? preferences.homeCurrency) !== 'USD',
  // On or before the books' closing date (Group 3's D10, for every record written).
  F3: ({ document, preferences }) =>
    preferences.bookCloseDate !== null &&
    document.date !== null &&
    document.date <= preferences.bookCloseDate,
  F4: (state) =>
    state.vendor.status === 'new' && newVendorName(state).name.length > MAXIMUM_NAME_LENGTH,
  F5: ({ vendor }) => vendor.status !== 'matched',
  F6: ({ vendor }) => vendor.status !== 'matched',
  F7: ({ verification }) =>
    verification.status === 'made' &&
    verification.differences.some((difference) => difference.field === 'documentType'),
};

/** The first rule of the document's path that applies; undefined when none does. */
export function failRuleOf(state: DecideState): FailRule | undefined {
  return PATH_FAILS[state.document.route].find((rule) => RULES[rule](state));
}
