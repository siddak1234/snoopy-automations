import {
  cardDigits,
  floorCents,
  formatLimit,
  formatMoney,
  sameCard,
  shorten,
} from '@autom8x/automation-kit/values';
import type { JsonObject } from '@autom8x/automation-sdk';

import { namedFields } from '../checks/fields.js';
import { PAID_PERSONALLY } from '../document.js';
import type { DecideState } from './contract.js';
import type { Matches } from './matches.js';

/**
 * decide's hold reasons (the plan's §2.4): one hold carries every reason that applies, in this
 * order, each a phrase in the approval's reason line and a detail in decide's timeline line.
 * A hold means a person can confirm the record as read against their own copy: approving creates
 * it exactly as planned, rejecting creates nothing.
 */

export const HOLD_ORDER = [
  'paid_personally',
  'over_limit',
  'new_vendor',
  'possible_duplicate',
  'may_be_statement',
  'matches_bill',
  'company_charge_found',
  'card_check',
  'payment_method',
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
  /** In the approval's reason line: "possible duplicate". */
  readonly phrase: string;
  /** In decide's timeline line, with what the line has room to say. */
  readonly detail: string;
}

/** The approval limit when the setting is missing, null or not a number of 0 or more: $500. */
export const DEFAULT_LIMIT_CENTS = 50_000;

/** The limit in whole cents, read exactly from the setting (500 when it is not a usable number). */
export function limitCentsOf(config: JsonObject): number {
  return floorCents(config.holdAboveAmount) ?? DEFAULT_LIMIT_CENTS;
}

/** An account's or a person's name inside a phrase: never more than 40 characters. */
const named = (name: string) => shorten(name, 40);
/** A record's number inside a phrase: cut to 30, as the reason line's ending cuts it. */
const numbered = (number: string | null) => (number === null ? null : shorten(number, 30));

export interface HoldContext {
  readonly state: DecideState;
  readonly config: JsonObject;
  readonly matches: Matches;
}

/** The payment method a company receipt was paid by, against what "Paid from" is (D18). */
function paymentMethodPhrase({ state, config }: HoldContext): string | null {
  const { document, accounts } = state;
  const paidFrom = accounts.paidFrom;
  if (!paidFrom) return null;
  const account = named(paidFrom.fullyQualifiedName);
  const card = paidFrom.accountType === 'Credit Card';
  switch (document.paymentMethod) {
    case 'not_shown':
      return 'payment method not shown';
    case 'cash':
      return `paid in cash, recorded from ${account}`;
    case 'other':
      return `paid by other means, recorded from ${account}`;
    case 'check':
      return card ? `paid by check, recorded from ${account}` : null;
    case 'bank_transfer':
      return card ? `paid by bank transfer, recorded from ${account}` : null;
    case 'card': {
      // A card against a bank account, unless confirmed as the company's; other digits are hold 8's.
      if (card) return null;
      const verdict = sameCard(cardDigits(document.cardLast4), cardDigits(config.companyCardLast4));
      return verdict === 'unknown' ? "card not confirmed as the company's" : null;
    }
  }
}

/** The card check (D19): other digits than the company card's; paid personally, the company card's. */
function cardPhrase({ state, config }: HoldContext): string | null {
  const { document } = state;
  const verdict = sameCard(cardDigits(document.cardLast4), cardDigits(config.companyCardLast4));
  if (PAID_PERSONALLY.has(document.route)) {
    return verdict === 'same' ? `card ending ${document.cardLast4} is the company card` : null;
  }
  const checked = document.route === 'company_receipt' || document.route === 'card_refund';
  return checked && verdict === 'different'
    ? `card ending ${document.cardLast4} isn't the company card`
    : null;
}

/** Every hold reason that applies, in the plan's order; none for a statement, which never holds. */
export function holdsOf(context: HoldContext): Hold[] {
  const { state, config, matches } = context;
  const { document, verification, vendor } = state;
  const route = document.route;
  if (route === 'statement') return [];
  const holds: Hold[] = [];
  const add = (code: HoldCode, phrase: string | null, detail?: string) => {
    if (phrase !== null) holds.push({ code, phrase, detail: detail ?? phrase });
  };
  const amount = document.amountCents ?? 0;
  const money = (cents: number | null) => formatMoney(cents ?? 0);
  const findings = new Set(document.findings);
  const newVendor = route === 'bill' && vendor?.status === 'new';

  add('paid_personally', PAID_PERSONALLY.has(route) ? 'paid personally' : null);
  const limit = limitCentsOf(config);
  add(
    'over_limit',
    amount > limit ? `over the ${formatLimit(limit)} limit` : null,
    `${money(amount)} is over the ${formatLimit(limit)} limit`,
  );
  const similar = state.similarVendors?.names.length ?? 0;
  add(
    'new_vendor',
    newVendor ? 'new vendor' : null,
    similar > 0
      ? `new vendor, ${similar} similar name${similar === 1 ? '' : 's'} in QuickBooks`
      : 'new vendor',
  );
  add(
    'possible_duplicate',
    matches.duplicates.length > 0 ? 'possible duplicate' : null,
    `possible duplicate: ${matches.duplicates.join(', ')}`,
  );
  if (route === 'bill') {
    const balance = vendor?.status === 'matched' ? vendor.balanceCents : null;
    const sameAsOpen = balance !== null && balance > 0 && document.totalCents === balance;
    const listsOthers = findings.has('lists_other_invoices');
    add(
      'may_be_statement',
      sameAsOpen || listsOthers ? 'may be a statement' : null,
      sameAsOpen
        ? 'may be a statement: its total is what QuickBooks shows open for this vendor'
        : `may be a statement: it lists ${document.listedInvoiceCount} other invoice${document.listedInvoiceCount === 1 ? '' : 's'}`,
    );
  }
  const bill = matches.matchedBill;
  if (route === 'company_receipt' && bill !== null) {
    const number = numbered(bill.docNumber);
    add(
      'matches_bill',
      bill.paid
        ? number === null
          ? 'matches a bill, already paid'
          : `matches bill ${number}, already paid`
        : number === null
          ? 'matches an open bill'
          : `matches open bill ${number}`,
    );
  }
  add(
    'company_charge_found',
    matches.companyCharges > 0 ? 'a company card or bank charge matches' : null,
    `${matches.companyCharges} company card or bank charge${matches.companyCharges === 1 ? '' : 's'} for this amount`,
  );
  add('card_check', cardPhrase(context));
  add('payment_method', route === 'company_receipt' ? paymentMethodPhrase(context) : null);
  add(
    'earlier_balance',
    findings.has('earlier_balance')
      ? `earlier balance ${money(document.earlierBalanceCents)} also due`
      : null,
  );
  add(
    'refund_method_not_shown',
    findings.has('refund_method_not_shown') ? 'refund method not shown' : null,
  );
  add(
    'tip_added',
    findings.has('tip_added')
      ? `tip of ${money(document.tipCents)} added to the printed total`
      : null,
  );
  add('amounts_mismatch', findings.has('amounts_mismatch') ? "amounts don't add up" : null);
  if (verification.status === 'made' && verification.differences.length > 0) {
    const fields = verification.differences.map((difference) => difference.field);
    const both = verification.differences
      .map(
        (difference) =>
          `${namedFields([difference.field])} ${difference.first} vs ${difference.second}`,
      )
      .join(', ');
    const recorded =
      verification.totalPicked === 'second'
        ? "; the second read's total recorded, it adds up"
        : '; the first read recorded';
    add(
      'reads_disagree',
      `reads disagree on ${namedFields(fields)}`,
      `reads disagree: ${both}${recorded}`,
    );
  }
  add(
    'second_check_not_made',
    verification.status === 'not_made' ? 'second check not made' : null,
    verification.status === 'not_made'
      ? `second check not made (${verification.reason})`
      : undefined,
  );
  add(
    'unclear_fields',
    findings.has('unclear_fields') ? `unclear: ${namedFields(document.unclearFields)}` : null,
  );
  add('not_cross_checked', findings.has('not_cross_checked') ? 'total not cross-checked' : null);
  add(
    'new_vendor_no_currency',
    newVendor && document.currency === null && !document.currencyUnrecognised
      ? 'no currency printed, USD will be used'
      : null,
  );
  const inUseBy =
    state.customerNameClash === 'match'
      ? 'a customer'
      : state.employeeNameClash === 'match'
        ? 'an employee'
        : null;
  add(
    'name_in_use',
    newVendor && inUseBy !== null ? `name used by ${inUseBy}, will be created with (vendor)` : null,
  );
  add(
    'currency_unrecognised',
    findings.has('currency_unrecognised') ? 'currency not recognised, USD will be used' : null,
  );
  return holds;
}
