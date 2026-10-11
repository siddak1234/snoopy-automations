/**
 * The credit sign rule (the plan's §2.2 and Group 2's D7): the AI copies minus signs as printed,
 * and code — never the AI — turns a credit note's amounts positive, so the arithmetic stays in
 * code. The discount, given as a positive number, is never one of the amounts weighed.
 *
 * - `as_printed`: no amount is negative; they are used as they are.
 * - `flipped`: every amount is zero or negative and one is below zero; each is turned positive.
 * - `mixed`: some are above zero and some below — the amounts don't add up (hold 13).
 */
export type CreditSigns = 'as_printed' | 'flipped' | 'mixed';

/** The rule for a credit note's amounts but its discount; an amount not printed (null) is not weighed. */
export function creditSignRule(amounts: readonly (number | null)[]): CreditSigns {
  const printed = amounts.filter((amount): amount is number => amount !== null);
  if (!printed.some((amount) => amount < 0)) return 'as_printed';
  return printed.some((amount) => amount > 0) ? 'mixed' : 'flipped';
}
