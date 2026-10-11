import {
  MAXIMUM_NUMBER_LENGTH,
  cardDigits,
  cleanCurrency,
  cleanText,
  creditSignRule,
  parseDate,
  toCents,
  type CardReading,
  type CentsReading,
  type CreditSigns,
  type CurrencyReading,
  type DateReading,
} from '@autom8x/automation-kit/values';

import type { Route } from '../document.js';
import type { StatementRow, StatementState } from '../state.js';
import type { FirstRead } from './answers.js';
import type { Parts } from './arithmetic.js';
import { RELEVANT_FIELDS, UNCLEAR_ORDER } from './fields.js';

/**
 * The cleaning (the plan's §2.2; Group 3's D1–D3): done once, here, so every later step uses only
 * clean values — text cleaned, money in whole cents, real dates from 2000 on, ISO 4217 codes; a
 * receipt's tip and card digits; a credit note's sign rule; a statement's rows. What cleaning
 * cannot read cleanly it marks unclear rather than guess.
 */

/** The most rows a statement's list holds (the prompt's rule 16; the plan's §2.2). */
export const MAXIMUM_ROWS = 40;

/** The first read, cleaned. */
export interface Cleaned {
  readonly read: FirstRead;
  readonly seller: string | null;
  /** May be longer than 100 characters, which fails (C14). */
  readonly number: string | null;
  readonly date: DateReading;
  readonly dueDate: DateReading;
  /** Printed terms of 0 to 365 days; null when none or not usable. */
  readonly termsDays: number | null;
  readonly currency: CurrencyReading;
  /** After the credit sign rule: a credit note's total is turned positive, or taken whole when its signs are mixed. */
  readonly total: CentsReading;
  readonly amountDueCents: number | null;
  /** A receipt's tip of 0 or more; a negative one is unclear and not used. */
  readonly tipCents: number | null;
  readonly parts: Parts;
  readonly signs: CreditSigns | null;
  readonly card: CardReading;
  readonly originalInvoiceNumber: string | null;
  readonly spendTypeUnclear: boolean;
  readonly listedInvoiceCount: number;
  readonly statement: StatementState | null;
  /** Fields cleaning found unclear: a fraction of a cent, a negative part, unusable terms, card digits. */
  readonly marked: ReadonlySet<string>;
}

/** An amount in whole cents, or null — marking the field when it is out of range or splits a cent. */
function centsOf(reading: CentsReading, field: string, marked: Set<string>): number | null {
  if (reading.kind === 'none') return null;
  if (reading.kind === 'out_of_range') {
    marked.add(field);
    return null;
  }
  if (reading.fraction) marked.add(field);
  return reading.cents;
}

/** The lines' sum, when they can be added: complete, 1 to 40, each with an amount in range. */
function linesOf(read: FirstRead, flip: boolean, marked: Set<string>): number | null {
  const { lineItems } = read;
  if (!read.lineItemsComplete || lineItems.length === 0 || lineItems.length > MAXIMUM_ROWS) {
    return null;
  }
  let total = 0;
  for (const line of lineItems) {
    const reading = toCents(line.amount);
    if (reading.kind !== 'cents') return null;
    if (reading.fraction) marked.add('lineItems');
    total += flip ? -reading.cents : reading.cents;
  }
  return total;
}

/** A supplier statement's rows, each reference cleaned like a document number; a row dropped makes the list incomplete. */
function statementOf(read: FirstRead, total: number | null, marked: Set<string>): StatementState {
  const rows: StatementRow[] = [];
  let dropped = read.listedItems.length > MAXIMUM_ROWS;
  for (const row of read.listedItems.slice(0, MAXIMUM_ROWS)) {
    const reference = cleanText(row.reference);
    const amount = toCents(row.amount);
    if (reference === null || reference.length > MAXIMUM_NUMBER_LENGTH || amount.kind !== 'cents') {
      dropped = true;
      continue;
    }
    if (amount.fraction) marked.add('listedItems');
    rows.push({ reference, amountCents: amount.cents, kind: row.kind });
  }
  const complete = read.listedItemsComplete && !dropped;
  let ownSumCents: number | null = null;
  if (complete && total !== null) {
    // (a) balance forward + invoices − payments − credits: a payment or credit subtracts
    // whichever sign it was printed with.
    ownSumCents = rows.reduce(
      (sum, row) =>
        row.kind === 'payment' || row.kind === 'credit'
          ? sum - Math.abs(row.amountCents)
          : sum + row.amountCents,
      0,
    );
  }
  return { rows, complete, ownSumCents };
}

export function cleanFirstRead(read: FirstRead): Cleaned {
  const marked = new Set<string>();
  const credit = read.documentType === 'credit_note';
  const receipt = read.documentType === 'receipt';

  // A credit note: every amount but the discount weighed for the sign rule first.
  const raw = {
    subtotal: toCents(read.subtotal),
    tax: toCents(read.tax),
    shipping: toCents(read.shipping),
    total: toCents(read.total),
    amountDue: toCents(read.amountDue),
  };
  const lineReadings = read.lineItems.map((line) => toCents(line.amount));
  const signs = credit
    ? creditSignRule(
        [...Object.values(raw), ...lineReadings].map((reading) =>
          reading.kind === 'cents' ? reading.cents : null,
        ),
      )
    : null;
  const flip = signs === 'flipped';
  const signed = (reading: CentsReading): CentsReading => {
    if (reading.kind !== 'cents' || !flip) return reading;
    return { ...reading, cents: reading.cents === 0 ? 0 : -reading.cents };
  };
  // A credit is its total, positive: turned so by the rule, or — signs mixed, which holds as
  // amounts that don't add up — taken whole, so a printed minus never reads as nothing to record.
  let total = signed(raw.total);
  if (credit && signs !== 'as_printed' && total.kind === 'cents') {
    total = { ...total, cents: Math.abs(total.cents) };
  }
  if (credit && total.kind === 'out_of_range') total = { kind: 'out_of_range', negative: false };
  if (total.kind === 'cents' && total.fraction) marked.add('total');
  if (total.kind === 'out_of_range') marked.add('total');

  const part = (field: 'subtotal' | 'tax' | 'shipping', reading: CentsReading) => {
    const cents = centsOf(signed(reading), field, marked);
    if (cents !== null && cents < 0) marked.add(field);
    return cents;
  };
  const discountCents = centsOf(toCents(read.discount), 'discount', marked);
  if (discountCents !== null && discountCents < 0) marked.add('discount');
  const parts: Parts = {
    subtotalCents: part('subtotal', raw.subtotal),
    taxCents: part('tax', raw.tax),
    shippingCents: part('shipping', raw.shipping),
    discountCents,
    linesCents: linesOf(read, flip, marked),
  };
  const amountDueCents = centsOf(signed(raw.amountDue), 'amountDue', marked);
  if (receipt && amountDueCents !== null && amountDueCents < 0) marked.add('amountDue');

  let tipCents = receipt ? centsOf(toCents(read.tip), 'tip', marked) : null;
  if (tipCents !== null && tipCents < 0) {
    marked.add('tip');
    tipCents = null;
  }

  const terms = read.paymentTermsDays;
  const termsUsable = terms !== null && Number.isInteger(terms) && terms >= 0 && terms <= 365;
  if (terms !== null && !termsUsable) marked.add('paymentTermsDays');

  const card = cardDigits(read.cardLast4);
  if (card.kind === 'unclear') marked.add('cardLast4');

  let originalInvoiceNumber = cleanText(read.originalInvoiceNumber);
  if (originalInvoiceNumber !== null && originalInvoiceNumber.length > MAXIMUM_NUMBER_LENGTH) {
    marked.add('originalInvoiceNumber');
    originalInvoiceNumber = null;
  }

  const totalCents = total.kind === 'cents' ? total.cents : null;
  return {
    read,
    seller: cleanText(read.vendorName),
    number: cleanText(read.documentNumber),
    date: parseDate(read.documentDate),
    dueDate: parseDate(read.dueDate),
    termsDays: termsUsable ? terms : null,
    currency: cleanCurrency(read.currency),
    total,
    amountDueCents,
    tipCents,
    parts,
    signs,
    card,
    originalInvoiceNumber,
    spendTypeUnclear: read.uncertainFields.includes('spendType'),
    listedInvoiceCount: read.listedItems.filter((row) => row.kind === 'invoice').length,
    statement:
      read.documentType === 'supplier_statement' ? statementOf(read, totalCents, marked) : null,
    marked,
  };
}

/** Whether a field the model listed as unclear still has a value after cleaning. */
function hasValue(cleaned: Cleaned, field: string): boolean {
  const { read } = cleaned;
  switch (field) {
    case 'documentType':
    case 'documentCount':
    case 'pagesMissing':
    case 'cashBackPrinted':
    case 'paymentMethod':
    case 'refundMethod':
      return true;
    case 'lineItems':
      return read.lineItems.length > 0;
    case 'listedItems':
      return read.listedItems.length > 0;
    default:
      return (read as unknown as Record<string, unknown>)[field] !== null;
  }
}

/**
 * The unclear fields, in display order (Group 3's D1): each the model listed, once, that still has
 * a value, and each cleaning marked — counted only where the route uses it, so a field that cannot
 * change the record never holds it. Spend type is never one: unclear, the default category serves.
 */
export function unclearFieldsOf(cleaned: Cleaned, route: Route): string[] {
  const relevant = RELEVANT_FIELDS[route];
  const listed = new Set(cleaned.read.uncertainFields);
  return UNCLEAR_ORDER.filter(
    (field) =>
      relevant.has(field) &&
      ((listed.has(field) && hasValue(cleaned, field)) || cleaned.marked.has(field)),
  );
}
