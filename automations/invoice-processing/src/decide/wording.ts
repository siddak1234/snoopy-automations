import {
  fitLine,
  fitReasonLine,
  formatLimit,
  formatMoney,
  shorten,
  type LinePiece,
} from '@autom8x/automation-kit/values';

import type { DecideState } from './contract.js';
import type { Hold } from './holds.js';
import { limitCentsOf } from './holds.js';
import type { Matches } from './matches.js';
import type { RecordPlan } from './plan.js';
import { joinWithin } from './words.js';

/**
 * What a person reads (the plan's §2.7, replacing Group 3's D7): the wording under decide's line,
 * which says what approving creates; the end of the approval's reason line, which says what the
 * record is; and decide's own timeline line. Each at most 200 characters; names — from QuickBooks,
 * the settings, or printed on the document — are shortened first with '…', and the amount always
 * stays.
 */

const nameOf = (state: DecideState, plan: RecordPlan): string =>
  plan.payee.kind === 'none' || plan.payee.kind === 'owner' || plan.payee.kind === 'employee'
    ? state.document.seller
    : plan.payee.name;

/** The number on a line: cut to 30 characters. */
const numberOf = (state: DecideState) =>
  state.document.number === null ? null : shorten(state.document.number, 30);

/** The wording under decide's line: what approving creates — and, for a receipt matching a bill, a warning. */
export function approvalWording(state: DecideState, plan: RecordPlan, matches: Matches): string {
  const amount = formatMoney(plan.amountCents);
  const payer = state.payer?.name ?? '';
  const paidFrom = { name: plan.accounts.paidFrom?.name ?? '' };
  switch (state.document.route) {
    case 'bill':
      return plan.payee.kind === 'new_vendor'
        ? 'Approve to create this vendor and bill in QuickBooks'
        : 'Approve to create this bill in QuickBooks';
    case 'company_receipt': {
      const bill = matches.matchedBill;
      if (bill !== null) {
        // An expense must not pay an existing bill (H1).
        const number = bill.docNumber === null ? null : shorten(bill.docNumber, 30);
        if (!bill.paid) {
          return number === null
            ? 'Approve only if this is a different purchase. If it pays that open bill, reject it and record the payment in Pay bills.'
            : `Approve only if this is a different purchase. If it pays bill ${number}, reject it and record the payment in Pay bills.`;
        }
        const which = number === null ? 'A bill from this seller' : `Bill ${number}`;
        const forAmount = bill.sameAmount ? ' for this amount' : '';
        return `Approve only if this is a different purchase. ${which}${forAmount} is already recorded and paid.`;
      }
      return fitLine(['Approve to record this expense, paid from ', paidFrom]);
    }
    case 'card_refund':
      return fitLine(['Approve to record this refund to ', paidFrom]);
    case 'vendor_credit':
      return fitLine(['Approve to record this vendor credit for ', { name: nameOf(state, plan) }]);
    case 'employee':
      return fitLine([
        'Approve to record this expense and that the company owes ',
        { name: payer },
        ` ${amount}`,
      ]);
    case 'owner':
      return fitLine([
        'Approve to record this expense as ',
        { name: payer },
        "'s owner investment",
      ]);
    case 'contractor':
      return fitLine([
        'Approve to create a bill so the company repays ',
        { name: payer },
        ` ${amount}`,
      ]);
    case 'statement':
      throw new Error('a statement is never approved');
  }
}

/** The end of the approval's reason line: what the record is, by path. */
export function reasonEnding(state: DecideState, plan: RecordPlan): LinePiece[] {
  const amount = formatMoney(plan.amountCents);
  const number = numberOf(state);
  const name = { name: nameOf(state, plan) };
  const seller = { name: state.document.seller };
  const payer = { name: state.payer?.name ?? '' };
  switch (state.document.route) {
    case 'bill':
      return [name, number === null ? '' : `, ${number}`, `, ${amount}`];
    case 'company_receipt':
      return [name, `, ${amount} from `, { name: plan.accounts.paidFrom?.name ?? '' }];
    case 'card_refund':
      return ['refund from ', name, `, ${amount}`];
    case 'vendor_credit':
      return ['credit from ', name, number === null ? '' : `, ${number}`, `, ${amount}`];
    case 'employee':
    case 'owner':
      return [payer, ' paid ', seller, `, ${amount}`];
    case 'contractor': {
      const marked =
        state.vendor?.status === 'matched' && state.vendor.vendor1099 === true
          ? ' (1099 vendor) paid '
          : ' (vendor, not marked 1099) paid ';
      return [payer, marked, seller, `, ${amount}`];
    }
    case 'statement':
      throw new Error('a statement is never approved');
  }
}

/** The approval's reason line: every hold's phrase, then the ending — "Paid personally; over the $500 limit: Jane Doe paid Office Depot, $612.40". */
export function reasonLine(state: DecideState, plan: RecordPlan, holds: readonly Hold[]): string {
  return fitReasonLine(
    holds.map((hold) => hold.phrase),
    reasonEnding(state, plan),
  );
}

/** What decide's line notes, not holds (the plan's §2.4): the category and why, a number in the memo, the rest. */
export function notesOf(state: DecideState, plan: RecordPlan): string[] {
  const { document, company, preferences } = state;
  const notes = [
    `category ${shorten(plan.accounts.category.name, 40)} (${plan.accounts.category.why})`,
  ];
  const numberKept =
    document.number !== null &&
    plan.docNumber === null &&
    (document.route === 'bill' || document.route === 'vendor_credit');
  if (numberKept) notes.push('number kept in the memo');
  if (document.sellerHasWebAddress) notes.push('name has a web address');
  if (document.termsDiffer) notes.push('terms differ from the printed due date');
  if (document.route === 'employee' && company.payrollFeature === true) {
    notes.push('repay through a Reimbursement pay item that posts to the same liability');
  }
  if (preferences.bookCloseDate === null) notes.push('no closing date from QuickBooks');
  return notes;
}

const CREATING: Readonly<Record<RecordPlan['record'], string>> = {
  bill: 'creating the bill',
  expense: 'recording the expense',
  card_refund: 'recording the refund',
  vendor_credit: 'recording the vendor credit',
  journal_entry: 'recording the journal entry',
};

/** decide's line when the run holds: every reason with its detail, then the notes. */
export function heldSummary(holds: readonly Hold[], notes: readonly string[]): string {
  const parts = [...holds.map((hold) => hold.detail), ...notes];
  return joinWithin([`Held: ${parts[0] ?? ''}`, ...parts.slice(1)], '');
}

/** decide's line when nothing holds: why, then what it creates, then the notes. */
export function straightSummary(
  state: DecideState,
  plan: RecordPlan,
  config: Parameters<typeof limitCentsOf>[0],
  notes: readonly string[],
): string {
  const amount = formatMoney(plan.amountCents);
  const limit = formatLimit(limitCentsOf(config));
  const vendor = state.vendor;
  const who =
    vendor?.status === 'matched'
      ? `${shorten(vendor.displayName, 40)} matched by ${vendor.matchedBy}`
      : 'no vendor to link, so no payee';
  return joinWithin(
    [
      `No reason to hold: ${amount} within the ${limit} limit, ${who}, no duplicate`,
      CREATING[plan.record],
      ...notes,
    ],
    '',
  );
}
