import type { SavedState } from '../decide/saved.js';
import { RECORD_WORDS, money } from '../words.js';
import type { CreatedState, NewVendorState } from './saved-state.js';

/**
 * What a person reads once the record is made: create-record's timeline line (§3.E) — `Recorded:
 * bill HOS-1042, $461.53` — and the next step, which the record's details carry (§2.8, v1's words,
 * at most 12 of them).
 */

/** Receipts and card refunds: the feed brings the same charge (H3, H4). */
export const MATCH_NOT_ADD = 'When this charge arrives in your bank feed, choose Match, not Add.';

/** The next step — how the money is matched, outside this automation; none for a bill or a vendor credit. */
export function nextStepOf(saved: SavedState): string | null {
  return saved.route === 'company_receipt' || saved.route === 'card_refund' ? MATCH_NOT_ADD : null;
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

/** create-record's line (§3.E): the record, the document's number, and the total QuickBooks shows. */
export function recordedLine(saved: SavedState, created: CreatedState): string {
  const { noun } = RECORD_WORDS[saved.plan.record];
  const number = saved.documentNumber === null ? '' : ` ${saved.documentNumber.slice(0, 30)}`;
  return `Recorded: ${noun}${number}, ${money(created.totalCents ?? saved.plan.amountCents)}`;
}
