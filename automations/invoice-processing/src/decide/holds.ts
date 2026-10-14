import { capitalised, floorCents, formatLimit, shorten } from '@autom8x/automation-kit/values';
import type { JsonObject } from '@autom8x/automation-sdk';

import { namedFields } from '../checks/fields.js';
import type { DecideState } from './contract.js';
import type { Matches } from './matches.js';

/**
 * decide's hold reasons (the plan's §2.4, in v2's words, §2.6): one hold carries every reason that
 * applies, in this order, each a short phrase. A hold means a person can confirm the record as read
 * against their own copy: approving creates it exactly as planned, rejecting creates nothing. Only
 * on the QuickBooks path: with the vendor "None" nothing waits for approval.
 */

export const HOLD_ORDER = [
  'over_limit',
  'new_vendor',
  'possible_duplicate',
  'may_be_statement',
  'matches_bill',
  'company_charge_found',
  'payment_method',
  'paid_from_pick',
  'earlier_balance',
  'refund_method_not_shown',
  'tip_added',
  'amounts_mismatch',
  'reads_disagree',
  'second_check_not_made',
  'unclear_fields',
  'not_cross_checked',
  'new_vendor_no_currency',
  'name_in_use',
  'currency_unrecognised',
] as const;
export type HoldCode = (typeof HOLD_ORDER)[number];

export interface Hold {
  readonly code: HoldCode;
  /** In the approval's reason: "new vendor". */
  readonly phrase: string;
}

/** The approval limit when the setting is missing, null or not a number of 0 or more: $500. */
export const DEFAULT_LIMIT_CENTS = 50_000;

/** The limit in whole cents, read exactly from the setting (500 when it is not a usable number). */
export function limitCentsOf(config: JsonObject): number {
  return floorCents(config.holdAboveAmount) ?? DEFAULT_LIMIT_CENTS;
}

export interface HoldContext {
  readonly state: DecideState;
  readonly config: JsonObject;
  readonly matches: Matches;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Every hold reason that applies, in the plan's order; none for a statement, which never holds. */
export function holdsOf(context: HoldContext): Hold[] {
  const { state, config, matches } = context;
  const { document, verification, vendor, paidFrom } = state;
  const route = document.route;
  if (route === 'statement') return [];
  const holds: Hold[] = [];
  const add = (code: HoldCode, phrase: string | null) => {
    if (phrase !== null) holds.push({ code, phrase });
  };
  const findings = new Set(document.findings);
  const newVendor = route === 'bill' && vendor.status === 'new';
  const limit = limitCentsOf(config);
  add(
    'over_limit',
    (document.amountCents ?? 0) > limit ? `over the ${formatLimit(limit)} limit` : null,
  );
  const similar = state.similarVendors?.names.length ?? 0;
  add(
    'new_vendor',
    !newVendor
      ? null
      : similar > 0
        ? `new vendor, ${similar} similar ${plural(similar, 'name', 'names')}`
        : 'new vendor',
  );
  add('possible_duplicate', matches.duplicates.length > 0 ? 'may already be in QuickBooks' : null);
  if (route === 'bill') {
    const balance = vendor.status === 'matched' ? vendor.balanceCents : null;
    const sameAsOpen = balance !== null && balance > 0 && document.totalCents === balance;
    add(
      'may_be_statement',
      sameAsOpen || findings.has('lists_other_invoices') ? 'may be a statement' : null,
    );
  }
  const bill = matches.matchedBill;
  add(
    'matches_bill',
    route !== 'company_receipt' || bill === null
      ? null
      : bill.paid
        ? 'matches a paid bill'
        : 'matches an open bill',
  );
  add('company_charge_found', matches.companyCharges > 0 ? 'a bank or card charge matches' : null);
  add(
    'payment_method',
    route === 'company_receipt' && document.paymentMethod === 'not_shown'
      ? 'payment method not shown'
      : null,
  );
  add(
    'paid_from_pick',
    paidFrom?.kind === 'ask' ? `paid from ${shorten(paidFrom.account.fullName, 40)}?` : null,
  );
  add('earlier_balance', findings.has('earlier_balance') ? 'earlier balance also due' : null);
  add(
    'refund_method_not_shown',
    findings.has('refund_method_not_shown') ? 'refund method not shown' : null,
  );
  add('tip_added', findings.has('tip_added') ? 'tip added to the total' : null);
  add('amounts_mismatch', findings.has('amounts_mismatch') ? "totals don't add up" : null);
  add(
    'reads_disagree',
    verification.status === 'made' && verification.differences.length > 0
      ? `two reads differ: ${namedFields(verification.differences.map((each) => each.field))}`
      : null,
  );
  add('second_check_not_made', verification.status === 'not_made' ? 'second read not made' : null);
  add(
    'unclear_fields',
    findings.has('unclear_fields') ? `unclear: ${namedFields(document.unclearFields)}` : null,
  );
  add('not_cross_checked', findings.has('not_cross_checked') ? 'total not checked' : null);
  add(
    'new_vendor_no_currency',
    newVendor && document.currency === null && !document.currencyUnrecognised
      ? 'no currency shown, USD used'
      : null,
  );
  const inUse = state.customerNameClash === 'match' || state.employeeNameClash === 'match';
  add('name_in_use', newVendor && inUse ? 'name used by a customer or employee' : null);
  add(
    'currency_unrecognised',
    findings.has('currency_unrecognised') ? 'currency not recognised' : null,
  );
  return holds;
}

/** The longest a reason may be: the platform's one-line bound. */
const REASON_MAXIMUM = 200;

/**
 * The approval's reason (§2.6, §3.F): every hold's phrase, joined by commas, the first letter
 * capitalised, ending with a full stop — "Over the $500 limit, new vendor." — in at most 200
 * characters: phrases that do not fit are left out from the end, and the first is shortened only
 * when it alone is too long; a line ending in a question keeps its question mark alone. Every
 * reason is in the saved data's `holdReasons`.
 */
export function reasonLine(holds: readonly Hold[]): string {
  let line = '';
  for (const { phrase } of holds) {
    const next = line === '' ? phrase : `${line}, ${phrase}`;
    if (next.length + 1 > REASON_MAXIMUM) break;
    line = next;
  }
  if (line === '' && holds.length > 0) line = shorten(holds[0]!.phrase, REASON_MAXIMUM - 1);
  // A phrase that asks — "paid from Checking?" — ends the line as it is.
  return `${capitalised(line)}${line.endsWith('?') ? '' : '.'}`;
}
