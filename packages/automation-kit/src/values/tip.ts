import { withinOneCent } from './money.js';

/**
 * The tip rule (the plan's §2.5): whether a receipt's total includes its tip, decided by the parts
 * printed before it, in whole cents within 1¢.
 *
 * - `none`: no tip, or a tip of 0.
 * - `included`: the parts add up WITH the tip — the total is the final amount paid.
 * - `added`: the parts add up only WITHOUT it — the total was printed before a tip was written
 *   in, so the amount paid is the total plus the tip, and the run holds (hold 12).
 * - `neither`: the parts add up neither way — the amounts don't add up (hold 13).
 * - `unknown`: nothing printed adds up to tell — the run fails (C28), since approving cannot
 *   change an amount.
 */
export type TipOutcome = 'none' | 'included' | 'added' | 'neither' | 'unknown';

/**
 * @param beforeTipCents the parts a receipt prints before its tip — its subtotal (or its lines),
 *   tax and shipping, less any discount — or null when it prints none to add up.
 */
export function tipRule(
  totalCents: number,
  tipCents: number | null,
  beforeTipCents: number | null,
): TipOutcome {
  if (tipCents === null || tipCents === 0) return 'none';
  if (beforeTipCents === null) return 'unknown';
  if (withinOneCent(beforeTipCents + tipCents, totalCents)) return 'included';
  if (withinOneCent(beforeTipCents, totalCents)) return 'added';
  return 'neither';
}
