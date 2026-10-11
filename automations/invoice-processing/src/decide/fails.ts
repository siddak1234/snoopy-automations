import { MAXIMUM_NAME_LENGTH } from '@autom8x/automation-kit/values';

import type { Route } from '../document.js';
import type { DecideState } from './contract.js';

/**
 * decide's fail rules (the plan's §2.3, F1–F7, and §2.6 per path): QuickBooks' own data rules the
 * record out, so a hold would ask a person to approve something that cannot be created — or, for
 * a statement, would hide a bill that may never be recorded (F7). The first that applies wins,
 * before any hold is weighed, and nothing is created.
 */

export const DECIDE_SENTENCES = {
  F1: 'This document is not in USD, and this automation records USD only. Enter it by hand in QuickBooks. Nothing was created.',
  F2: 'This vendor is set up in QuickBooks in another currency, and this automation records USD only. Nothing was created.',
  F3: "The document's date is in a period closed in QuickBooks. Nothing was created.",
  F4: "The vendor's name is too long to add '(vendor)' in QuickBooks. Enter this bill by hand. Nothing was created.",
  F5: "This credit note's vendor isn't in QuickBooks. Credit notes are recorded only for existing vendors. Nothing was created.",
  F6: "This statement's vendor isn't in QuickBooks, so there is nothing to compare it with. Nothing was created.",
  F7: 'The two reads disagree on whether this is a supplier statement. Check the document, and if it is a bill, enter it by hand in QuickBooks. Nothing was created.',
  /** Guards that should never fire. */
  state_incomplete:
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
  saved_too_large:
    'Bills & Receipts could not save this document for approval. Run it again. Nothing was created.',
} as const;

export type DecideFailure = keyof typeof DECIDE_SENTENCES;
export type FailRule = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7';

/** Each rule's word for the timeline. */
export const DECIDE_REASONS: Readonly<Record<DecideFailure, string>> = {
  F1: 'currency_not_usd',
  F2: 'vendor_currency_not_usd',
  F3: 'period_closed',
  F4: 'new_vendor_name_too_long',
  F5: 'credit_vendor_missing',
  F6: 'statement_vendor_missing',
  F7: 'reads_disagree_on_statement',
  state_incomplete: 'state_incomplete',
  saved_too_large: 'saved_too_large',
};

/** The rules each path checks (the plan's §2.6). */
export const PATH_FAILS: Readonly<Record<Route, readonly FailRule[]>> = {
  bill: ['F1', 'F2', 'F3', 'F4'],
  company_receipt: ['F1', 'F2', 'F3'],
  card_refund: ['F1', 'F2', 'F3'],
  vendor_credit: ['F1', 'F2', 'F3', 'F5'],
  employee: ['F1', 'F3'],
  owner: ['F1', 'F3'],
  contractor: ['F1', 'F2', 'F3'],
  statement: ['F1', 'F2', 'F6', 'F7'],
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
    vendor?.status === 'matched' && (vendor.currency ?? preferences.homeCurrency) !== 'USD',
  // On or before the books' closing date (Group 3's D10, for every record written).
  F3: ({ document, preferences }) =>
    preferences.bookCloseDate !== null &&
    document.date !== null &&
    document.date <= preferences.bookCloseDate,
  F4: (state) =>
    state.vendor?.status === 'new' && newVendorName(state).name.length > MAXIMUM_NAME_LENGTH,
  F5: ({ vendor }) => vendor?.status !== 'matched',
  F6: ({ vendor }) => vendor?.status !== 'matched',
  F7: ({ verification }) =>
    verification.status === 'made' &&
    verification.differences.some((difference) => difference.field === 'documentType'),
};

/** The first fail rule of the document's path that applies; undefined when none does. */
export function failRuleOf(state: DecideState): FailRule | undefined {
  return PATH_FAILS[state.document.route].find((rule) => RULES[rule](state));
}
