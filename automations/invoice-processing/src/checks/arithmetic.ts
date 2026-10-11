import {
  MAXIMUM_CENTS,
  tipRule,
  withinOneCent,
  type CreditSigns,
  type TipOutcome,
} from '@autom8x/automation-kit/values';

import type { KeptType } from '../document.js';
import type { CheckResult, Finding } from '../state.js';

/**
 * The arithmetic (the plan's §2.5), in whole cents within 1¢, done in code and never by the AI
 * (Group 2's D7). One function for `check-document` and for the second read's re-check after its
 * tie-break records the other total (Group 3's D9), so both reach the same verdicts.
 */

/** The parts a document prints, cleaned; the lines' sum only when they can be added. */
export interface Parts {
  readonly subtotalCents: number | null;
  readonly taxCents: number | null;
  readonly shippingCents: number | null;
  readonly discountCents: number | null;
  readonly linesCents: number | null;
}

/** What the arithmetic says about one total. */
export interface Amounts {
  readonly tip: TipOutcome;
  /** What the record carries: the total, plus a tip the total was printed before (hold 12). */
  readonly amountCents: number;
  readonly parts: CheckResult;
  readonly lines: CheckResult;
  /** A bill's amount due over its charges (D24). */
  readonly earlierBalanceCents: number | null;
  /** amounts_mismatch, not_cross_checked, tip_added, earlier_balance — in that order. */
  readonly findings: readonly Finding[];
}

const sum = (...values: (number | null)[]) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

function compare(expected: number, total: number): CheckResult {
  return withinOneCent(expected, total) ? 'passed' : 'missed';
}

/**
 * The checks for one total.
 *
 * - Parts, when a subtotal is printed: subtotal + tax + shipping (+ a tip the total includes)
 *   − discount against the total. A missing part counts 0.
 * - Lines, when they can be added: against the subtotal, or with none printed against the total
 *   less the other parts — the lines stand in for the subtotal (Group 3's D2).
 * - A receipt's tip: the parts, before it, decide whether the total includes it (`tipRule`).
 * - A credit note whose signs are mixed adds up no way: amounts don't add up, nothing checked.
 * - A bill's amount due: larger than its charges is an earlier balance, recorded as this
 *   period's charges and held (D24); smaller fails (C15, `amountFailure`).
 */
export function amountsOf(
  type: KeptType,
  parts: Parts,
  signs: CreditSigns | null,
  totalCents: number,
  tipCents: number | null,
  amountDueCents: number | null,
): Amounts {
  const { subtotalCents, taxCents, shippingCents, discountCents, linesCents } = parts;
  const extras = sum(taxCents, shippingCents) - (discountCents ?? 0);
  const base = subtotalCents ?? linesCents;
  const tip: TipOutcome =
    type === 'receipt'
      ? tipRule(totalCents, tipCents, base === null ? null : base + extras)
      : 'none';
  // The tip the total is checked WITH: none when it was added after the total was printed.
  const tipIn = tip === 'included' || tip === 'neither' ? (tipCents ?? 0) : 0;
  const added = tip === 'added' ? (tipCents ?? 0) : 0;
  const earlier =
    type === 'bill' && amountDueCents !== null && amountDueCents > totalCents
      ? amountDueCents - totalCents
      : null;
  const findings: Finding[] = [];
  let partsResult: CheckResult = 'not_run';
  let linesResult: CheckResult = 'not_run';
  if (signs === 'mixed') {
    findings.push('amounts_mismatch');
  } else {
    if (subtotalCents !== null) {
      partsResult = compare(subtotalCents + extras + tipIn, totalCents);
    }
    if (linesCents !== null) {
      linesResult =
        subtotalCents !== null
          ? compare(linesCents, subtotalCents)
          : compare(linesCents + extras + tipIn, totalCents);
    }
    if (partsResult === 'missed' || linesResult === 'missed') findings.push('amounts_mismatch');
    else if (partsResult === 'not_run' && linesResult === 'not_run') {
      findings.push('not_cross_checked');
    }
  }
  if (tip === 'added') findings.push('tip_added');
  if (earlier !== null) findings.push('earlier_balance');
  return {
    tip,
    amountCents: totalCents + added,
    parts: partsResult,
    lines: linesResult,
    earlierBalanceCents: earlier,
    findings,
  };
}

/**
 * Whether a total agrees with the document's own arithmetic: a check that weighs the total ran
 * and passed, none missed, and a receipt's tip is settled. The second read's tie-break (Group 2's
 * D4) records the other read's total only when it agrees and the first's does not.
 */
export function totalAgrees(
  type: KeptType,
  parts: Parts,
  signs: CreditSigns | null,
  totalCents: number,
  tipCents: number | null,
): boolean {
  const amounts = amountsOf(type, parts, signs, totalCents, tipCents, null);
  const weighed = parts.subtotalCents !== null ? amounts.parts : amounts.lines;
  return (
    weighed === 'passed' &&
    amounts.parts !== 'missed' &&
    amounts.lines !== 'missed' &&
    amounts.tip !== 'neither' &&
    amounts.tip !== 'unknown'
  );
}

/** C13: the total, or the amount with a tip added, is more than QuickBooks takes. */
export function overMaximum(totalCents: number, amounts: Amounts): boolean {
  return totalCents > MAXIMUM_CENTS || amounts.amountCents > MAXIMUM_CENTS;
}

/** C15: a bill's amount due is below its charges, 0.00 included — part or all of it paid or credited. */
export function dueBelowCharges(
  type: KeptType,
  totalCents: number,
  amountDueCents: number | null,
): boolean {
  return type === 'bill' && amountDueCents !== null && amountDueCents < totalCents;
}

/**
 * The fail rules that weigh the total, in their order (C12, C13, C15), for the second read's
 * re-check: zero or less after the credit sign rule; more than QuickBooks takes; a bill's amount
 * due below its charges. Undefined when none applies.
 */
export function amountFailure(
  type: KeptType,
  totalCents: number,
  amounts: Amounts,
  amountDueCents: number | null,
): 'C12' | 'C13' | 'C15' | undefined {
  if (totalCents <= 0) return 'C12';
  if (overMaximum(totalCents, amounts)) return 'C13';
  if (dueBelowCharges(type, totalCents, amountDueCents)) return 'C15';
  return undefined;
}
