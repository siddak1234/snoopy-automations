import { fitLine, formatMoney, shorten, type LinePiece } from '@autom8x/automation-kit/values';

import type { RecordPlan } from '../decide/plan.js';
import type { SavedState } from '../decide/saved.js';
import type { CreatedState, NewVendorState } from './saved-state.js';

/**
 * What a person reads once the record is made (the plan's §5, "Next-step lines in the timeline"):
 * create-record's timeline line, which is also the run's summary — both apps show those, and the
 * email cannot carry the next step alone, as it goes only to the optional "Also email" address —
 * each at most 200 characters, names shortened first, the amount and the next step always whole:
 * "Recorded expense 145 from Chase Visa, $45.20. When this charge arrives in your bank feed,
 * choose Match, not Add."
 */

/** The record's name, as a person reads it. */
export const NOUNS: Readonly<Record<RecordPlan['record'], string>> = {
  bill: 'bill',
  expense: 'expense',
  card_refund: 'refund',
  vendor_credit: 'vendor credit',
  journal_entry: 'journal entry',
};

/** The noun the kit's write sentences use (`QUICKBOOKS_WRITES`): a refund is an expense there. */
export const WRITE_NOUNS: Readonly<Record<RecordPlan['record'], string>> = {
  ...NOUNS,
  card_refund: 'expense',
};

/** Receipts and card refunds: the feed brings the same charge (H3, H4). */
export const MATCH_NOT_ADD = 'When this charge arrives in your bank feed, choose Match, not Add.';
/** Contractors: their bill is paid as any bill is (H6, H3). */
export const PAY_BILLS = 'Pay it in Pay bills.';

/**
 * The next step per path — how the money is matched or repaid, outside this automation — as
 * pieces whose account names may be shortened; none for a bill or a vendor credit.
 */
export function nextStepPieces(saved: SavedState): LinePiece[] | null {
  const { plan } = saved;
  switch (saved.route) {
    case 'company_receipt':
    case 'card_refund':
      return [MATCH_NOT_ADD];
    case 'employee':
      // H6: a check or expense to the employee, the same liability as its category.
      return [
        'Repay with a check or expense using ',
        { name: plan.accounts.liability?.name ?? '' },
        ' as the category.',
      ];
    case 'owner':
      // H8: a repayment is categorised to the same equity account.
      return ['Categorise the repayment to ', { name: plan.accounts.equity?.name ?? '' }, '.'];
    case 'contractor':
      return [PAY_BILLS];
    default:
      return null;
  }
}

/** The next step as one line, its account names whole; null for a bill or a vendor credit. */
export function nextStepOf(saved: SavedState): string | null {
  const pieces = nextStepPieces(saved);
  return pieces === null ? null : fitLine(pieces);
}

/** The vendor the record names, as QuickBooks named it on the record when it did. */
export function payeeNameOf(
  saved: SavedState,
  created: CreatedState | null,
  newVendor: NewVendorState | null,
): string | null {
  const { payee } = saved.plan;
  if (created?.payeeName) return created.payeeName;
  if (payee.kind === 'new_vendor') return newVendor?.displayName ?? payee.name;
  return payee.kind === 'none' ? null : payee.name;
}

/**
 * create-record's line and the run's summary: the record, its QuickBooks Id, what it is, and the
 * next step.
 */
export function recordedLine(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
): string {
  const { plan } = saved;
  const id = shorten(created.id, 20);
  const amount = formatMoney(plan.amountCents);
  const vendor = { name: payeeNameOf(saved, created, newVendor) ?? saved.seller };
  const paidFrom = { name: plan.accounts.paidFrom?.name ?? '' };
  const person = { name: saved.payer?.name ?? '' };
  const number = saved.documentNumber === null ? '' : `, ${shorten(saved.documentNumber, 30)}`;
  const differs =
    created.totalCents !== null && created.totalCents !== plan.amountCents
      ? `; QuickBooks shows ${formatMoney(created.totalCents)}`
      : '';
  const what: LinePiece[] = (() => {
    switch (saved.route) {
      case 'bill': {
        const due = created.dueDate === null ? '' : `, due ${created.dueDate}`;
        return [`Recorded bill ${id} from `, vendor, `${number}, ${amount}${due}${differs}.`];
      }
      case 'contractor':
        return [`Recorded bill ${id} to `, person, `, ${amount}${differs}.`];
      case 'company_receipt':
        return [`Recorded expense ${id} from `, paidFrom, `, ${amount}${differs}.`];
      case 'card_refund':
        return [`Recorded refund ${id} to `, paidFrom, `, ${amount}${differs}.`];
      case 'vendor_credit':
        return [`Recorded vendor credit ${id} from `, vendor, `${number}, ${amount}${differs}.`];
      case 'employee':
        return [`Recorded journal entry ${id}: the company owes `, person, ` ${amount}.`];
      case 'owner':
        return [`Recorded journal entry ${id}: `, person, `'s owner investment of ${amount}.`];
      case 'statement':
        throw new Error('a statement is compared, never recorded');
    }
  })();
  const next = nextStepPieces(saved);
  return fitLine(next === null ? what : [...what, ' ', ...next]);
}
