import {
  cardDigits,
  cleanCurrency,
  cleanText,
  formatMoney,
  parseDate,
  toCents,
} from '@autom8x/automation-kit/values';

import type { SecondRead } from '../checks/answers.js';
import { amountFailure, amountsOf, totalAgrees, type Parts } from '../checks/arithmetic.js';
import { findingsOf } from '../checks/check.js';
import { COMPARED_FIELDS } from '../checks/fields.js';
import { roughlySameSeller } from '../names.js';
import type { ComparedField, Difference, DocumentState } from '../state.js';

/**
 * The agreement gate (the plan's §4; Group 2's D3 and D4; Group 3's D8 and D9): the second read
 * against the first, field by field, on the fields its route writes. Each value is cleaned the one
 * way the first was, then compared exactly — the seller's name roughly — and any difference holds
 * the run, which says both values and what will be written: the first read's, unless the totals
 * differ and only the second agrees with the document's own arithmetic. Spend type is the one field
 * that never holds: disputed, the default category serves (D27).
 */

/** One field's value from one read, as compared (`key`) and as a person reads it (`shown`). */
interface Value {
  readonly key: string | null;
  readonly shown: string;
}

const NONE: Value = { key: null, shown: 'none' };

const WORDS: Readonly<Record<string, string>> = {
  credit_note: 'credit note',
  supplier_statement: 'supplier statement',
  bank_statement: 'bank statement',
  purchase_order: 'purchase order',
  bank_transfer: 'bank transfer',
  not_shown: 'not shown',
  credit_on_account: 'credit on account',
  refund_to_card: 'refund to a card',
  refund_by_check_or_cash: 'refund by check or cash',
};

const word = (value: string): Value => ({ key: value, shown: WORDS[value] ?? value });
const text = (value: string | null): Value =>
  value === null ? NONE : { key: value, shown: value };

function dateValue(value: unknown): Value {
  const reading = parseDate(value);
  if (reading.kind === 'none') return NONE;
  return reading.kind === 'date'
    ? { key: reading.date, shown: reading.date }
    : { key: 'invalid', shown: 'not a valid date' };
}

function moneyValue(cents: number | null, currency: string): Value {
  return cents === null ? NONE : { key: String(cents), shown: formatMoney(cents, currency) };
}

/** A credit note's amounts are compared positive: the sign rule makes the first read's so. */
function secondCents(value: unknown, credit: boolean): number | null | 'out_of_range' {
  const reading = toCents(value);
  if (reading.kind === 'none') return null;
  if (reading.kind === 'out_of_range') return 'out_of_range';
  return credit ? Math.abs(reading.cents) : reading.cents;
}

/** A credit note gives its credit somehow: `not_applicable` on one reads as not shown. */
function refundOf(value: string, credit: boolean): string {
  return credit && value === 'not_applicable' ? 'not_shown' : value;
}

/** Both reads' value of one field, cleaned the same way. */
function valuesOf(
  field: ComparedField,
  document: DocumentState,
  second: SecondRead,
): [Value, Value] {
  const credit = document.type === 'credit_note';
  const currency = document.currency ?? 'USD';
  switch (field) {
    case 'documentType':
      return [word(document.type), word(second.documentType)];
    case 'vendorName':
      return [text(document.seller), text(cleanText(second.vendorName))];
    case 'documentNumber':
      return [text(document.number), text(cleanText(second.documentNumber))];
    case 'documentDate':
      return [document.date === null ? NONE : text(document.date), dateValue(second.documentDate)];
    case 'dueDate':
      return [
        document.dueDateSource === 'printed' ? text(document.dueDate) : NONE,
        dateValue(second.dueDate),
      ];
    case 'currency': {
      const reading = cleanCurrency(second.currency);
      const first = document.currencyUnrecognised
        ? { key: 'unrecognised', shown: 'not recognised' }
        : text(document.currency);
      const other =
        reading.kind === 'code'
          ? text(reading.code)
          : reading.kind === 'unrecognised'
            ? { key: 'unrecognised', shown: 'not recognised' }
            : NONE;
      return [first, other];
    }
    case 'total':
    case 'amountDue': {
      const first = field === 'total' ? document.totalCents : document.amountDueCents;
      const other = secondCents(second[field], credit);
      return [
        moneyValue(first, currency),
        other === 'out_of_range'
          ? { key: 'out_of_range', shown: 'too large to read' }
          : moneyValue(other, currency),
      ];
    }
    case 'paymentMethod':
      return [word(document.paymentMethod), word(second.paymentMethod)];
    case 'cardLast4': {
      const reading = cardDigits(second.cardLast4);
      const first = document.cardDigitsUnclear
        ? { key: 'unclear', shown: 'unclear' }
        : text(document.cardLast4);
      const other =
        reading.kind === 'digits'
          ? text(reading.digits)
          : reading.kind === 'unclear'
            ? { key: 'unclear', shown: 'unclear' }
            : NONE;
      return [first, other];
    }
    case 'cashBackPrinted':
      return [
        { key: String(document.cashBackPrinted), shown: document.cashBackPrinted ? 'yes' : 'no' },
        { key: String(second.cashBackPrinted), shown: second.cashBackPrinted ? 'yes' : 'no' },
      ];
    case 'refundMethod':
      return [
        word(refundOf(document.refundMethod, credit)),
        word(refundOf(second.refundMethod, credit)),
      ];
    case 'spendType':
      return [word(document.spendType), word(second.spendType)];
  }
}

function same(field: ComparedField, first: Value, second: Value): boolean {
  if (field === 'vendorName' && first.key !== null && second.key !== null) {
    return roughlySameSeller(first.key, second.key);
  }
  return first.key === second.key;
}

/** The two reads compared on the first read's route. */
export interface Comparison {
  readonly compared: readonly ComparedField[];
  readonly differences: readonly Difference[];
  /** When the totals differ: whose the record carries (D4); null when they agree or are not compared. */
  readonly totalPicked: 'first' | 'second' | null;
  /** The second read's total in whole cents, when the tie-break records it. */
  readonly secondTotalCents: number | null;
  readonly spendTypeDisputed: boolean;
}

/** The parts the arithmetic weighs, from the first read's state. */
export function partsOf(document: DocumentState): Parts {
  const { subtotalCents, taxCents, shippingCents, discountCents, linesCents } = document.arithmetic;
  return { subtotalCents, taxCents, shippingCents, discountCents, linesCents };
}

export function compareReads(document: DocumentState, second: SecondRead): Comparison {
  const compared = COMPARED_FIELDS[document.route];
  const differences: Difference[] = [];
  let spendTypeDisputed = false;
  for (const field of compared) {
    const [first, other] = valuesOf(field, document, second);
    if (same(field, first, other)) continue;
    if (field === 'spendType') spendTypeDisputed = true;
    else differences.push({ field, first: first.shown, second: other.shown });
  }
  const totalDiffers = differences.some((difference) => difference.field === 'total');
  let totalPicked: 'first' | 'second' | null = null;
  let secondTotalCents: number | null = null;
  if (totalDiffers) {
    totalPicked = 'first';
    const other = secondCents(second.total, document.type === 'credit_note');
    const parts = partsOf(document);
    const { signs } = document.arithmetic;
    if (
      typeof other === 'number' &&
      document.totalCents !== null &&
      totalAgrees(document.type, parts, signs, other, document.tipCents) &&
      !totalAgrees(document.type, parts, signs, document.totalCents, document.tipCents)
    ) {
      totalPicked = 'second';
      secondTotalCents = other;
    }
  }
  return { compared, differences, totalPicked, secondTotalCents, spendTypeDisputed };
}

/**
 * The arithmetic run again on the second read's total, once the tie-break records it (Group 3's
 * D9): the tip, the amount, an earlier balance and what the checks found follow the new total, and
 * a fail rule it now meets — zero or less, more than QuickBooks takes, an amount due below the
 * charges — ends the run with check-document's own sentence. Every other value stays the first
 * read's.
 */
export function recheckedWith(
  document: DocumentState,
  totalCents: number,
):
  | { readonly outcome: 'ok'; readonly document: DocumentState }
  | { readonly outcome: 'failed'; readonly rule: 'C12' | 'C13' | 'C15' } {
  const parts = partsOf(document);
  const { signs } = document.arithmetic;
  const amounts = amountsOf(
    document.type,
    parts,
    signs,
    totalCents,
    document.tipCents,
    document.amountDueCents,
  );
  const rule = amountFailure(document.type, totalCents, amounts, document.amountDueCents);
  if (rule !== undefined) return { outcome: 'failed', rule };
  return {
    outcome: 'ok',
    document: {
      ...document,
      totalCents,
      amountCents: amounts.amountCents,
      earlierBalanceCents: amounts.earlierBalanceCents,
      tip: amounts.tip,
      arithmetic: { ...parts, signs, parts: amounts.parts, lines: amounts.lines },
      findings: findingsOf(document, amounts, document.unclearFields),
    },
  };
}
