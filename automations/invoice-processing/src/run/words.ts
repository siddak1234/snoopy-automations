import { cleanCurrency, cleanText, shorten, toCents } from '@autom8x/automation-kit/values';

import { LINE_MAXIMUM, RESULTS, lineWith, money, nameWords } from '../words.js';
import type { DocumentAnswer, ReadType } from './answer.js';

/**
 * The words v3 adds (the session's spec of 2026-10-15, §3.5, as the owner's AM1, AM7 and AM8
 * change it): short, plain, no codes — and nothing from a model's or QuickBooks' own text beyond a
 * seller's name and a total, as v2's lines (`src/words.ts`) say them.
 */

/** What a document is, inside a line: "Read: receipt from …". */
export const TYPE_NOUNS: Readonly<Record<ReadType, string>> = {
  bill: 'bill',
  invoice: 'invoice',
  receipt: 'receipt',
  credit_note: 'credit note',
  supplier_statement: 'statement',
  bank_statement: 'bank statement',
  quote: 'quote',
  purchase_order: 'purchase order',
  other_financial: 'document',
  not_financial: 'page',
};

/** Why a document waits, before decide's own: each lowercase, joined into one approval line. */
export const DOUBTS = {
  C6: 'pages may be missing',
  C8: "the seller's name can't be read",
  C11: "the total can't be read",
  C21: "the date can't be read",
  C22: "the date isn't a real date",
  C26: 'nothing on this statement can be read',
  answer_unusable: "it can't be read",
  not_financial: "this doesn't look like a bill, receipt or invoice",
  count_differs: 'two reads differ: number of documents',
} as const;

/** Two documents in one file with the same seller, date and total: the second waits. */
export const sameAs = (index: number): string => `same as document ${index}`;

/** A total as a person reads it, from the decimal string the result carries. */
export function totalWords(total: string | null, currency: string | null): string | null {
  if (total === null) return null;
  const cents = toCents(Number(total));
  return cents.kind === 'cents' ? money(Math.abs(cents.cents), currency) : null;
}

/** "3 receipts" when all are receipts, "3 bills" when all are bills or invoices, else "3 documents". */
export function countedNoun(types: readonly ReadType[]): string {
  const n = types.length;
  if (types.every((type) => type === 'receipt')) return `${n} ${n === 1 ? 'receipt' : 'receipts'}`;
  if (types.every((type) => type === 'bill' || type === 'invoice')) {
    return `${n} ${n === 1 ? 'bill' : 'bills'}`;
  }
  return `${n} ${n === 1 ? 'document' : 'documents'}`;
}

/** The first read's line (§3.E): one document as v2 said it; several counted. */
export function readLine(documents: readonly DocumentAnswer[]): string {
  if (documents.length !== 1)
    return `Read: ${countedNoun(documents.map((each) => each.documentType))}`;
  const [document] = documents as [DocumentAnswer];
  const type = TYPE_NOUNS[document.documentType];
  const seller = cleanText(document.vendorName);
  const total = toCents(document.total);
  const currency = cleanCurrency(document.currency);
  const code = currency.kind === 'code' ? currency.code : null;
  const amount = total.kind === 'cents' ? `, ${money(Math.abs(total.cents), code)}` : '';
  return seller === null
    ? lineWith(`Read: ${type}`, '', amount)
    : lineWith(`Read: ${type} from `, seller, amount);
}

/** A step's line for several documents, or one: fixed words and counts, at most 80 characters. */
export function countLine(parts: readonly (readonly [count: number, words: string])[]): string {
  const said = parts.filter(([count]) => count > 0).map(([count, words]) => `${count} ${words}`);
  return shorten(said.join(', '), LINE_MAXIMUM);
}

/** What became of one document, for its status line and the run's summary. */
export type Outcome =
  | {
      readonly status: 'recorded';
      readonly noun: string;
      readonly vendor: string;
      readonly total: string;
    }
  | { readonly status: 'saved'; readonly why: string | null }
  | { readonly status: 'not_recorded'; readonly reason: string }
  | { readonly status: 'unconfirmed' }
  | { readonly status: 'compared'; readonly missing: number }
  | { readonly status: 'waiting'; readonly reason: string };

/** A document's `statusText` (§3.5): one line, the automation's words. */
export function statusText(outcome: Outcome): string {
  switch (outcome.status) {
    case 'recorded':
      return `Recorded in QuickBooks: ${outcome.noun}`;
    case 'saved':
      return outcome.why === null ? 'Saved' : `Saved. ${outcome.why}`;
    case 'not_recorded':
      return `Saved. Not recorded in QuickBooks: ${outcome.reason}`;
    case 'unconfirmed':
      return RESULTS.unconfirmed;
    case 'compared':
      return `Compared with QuickBooks: ${invoices(outcome.missing)} not in QuickBooks`;
    case 'waiting':
      return `Waiting for approval: ${outcome.reason}`;
  }
}

const invoices = (count: number) => `${count} ${count === 1 ? 'invoice' : 'invoices'}`;

/** Why QuickBooks keeps no record of a financial document it has none for (the owner's AM8). */
export const NO_RECORD_FOR: Readonly<Partial<Record<ReadType, string>>> = {
  bank_statement: 'QuickBooks has no record for a bank statement.',
  quote: 'QuickBooks has no record for a quote.',
  purchase_order: 'QuickBooks has no record for a purchase order.',
  other_financial: 'QuickBooks has no record for this document.',
};

/** One document's summary (§3.5): v2's result sentences (`RESULTS`). */
function oneSummary(outcome: Outcome, seller: string | null, total: string | null, noun: string) {
  switch (outcome.status) {
    case 'recorded':
      // A record whose total the state no longer holds is named without one (v2's guard).
      return outcome.total === ''
        ? `Recorded in QuickBooks: ${outcome.noun} from ${nameWords(outcome.vendor)}.`
        : RESULTS.recorded(outcome.noun, outcome.vendor, outcome.total);
    case 'saved':
      return seller === null
        ? `Saved: ${noun}${total === null ? '' : `, ${total}`}.`
        : RESULTS.saved(seller, total);
    case 'not_recorded':
      return RESULTS.notRecorded(outcome.reason);
    case 'unconfirmed':
      return RESULTS.unconfirmed;
    case 'compared':
      return RESULTS.compared(outcome.missing);
    case 'waiting':
      return `Waiting for approval: ${outcome.reason}.`;
  }
}

/** What a summary counts, in its order (§3.5). */
const COUNTED: readonly (readonly [Outcome['status'], string])[] = [
  ['recorded', 'recorded in QuickBooks'],
  ['saved', 'saved'],
  ['not_recorded', 'not recorded'],
  ['unconfirmed', 'not confirmed'],
  ['compared', 'compared'],
  ['waiting', 'waiting for approval'],
];

export interface Summarised {
  readonly outcome: Outcome;
  readonly type: ReadType;
  readonly seller: string | null;
  readonly total: string | null;
}

/**
 * The run's summary (`resultSummary`, §3.5): one document → v2's sentence; several → "3 receipts:
 * 2 recorded in QuickBooks, 1 saved." — each count only when there is one. At most 200 characters.
 */
export function runSummary(documents: readonly Summarised[]): string {
  if (documents.length === 1) {
    const [only] = documents as [Summarised];
    return shorten(oneSummary(only.outcome, only.seller, only.total, TYPE_NOUNS[only.type]), 200);
  }
  const parts = COUNTED.map(
    ([status, words]) =>
      [documents.filter((each) => each.outcome.status === status).length, words] as const,
  )
    .filter(([count]) => count > 0)
    .map(([count, words]) => `${count} ${words}`);
  return shorten(`${countedNoun(documents.map((each) => each.type))}: ${parts.join(', ')}.`, 200);
}

/** The platform's bound on the approval's reason: one line, 200 characters. */
const REASON_MAXIMUM = 200;

/**
 * The approval's reason (§B4): "Document 2: the total can't be read." for each waiting document,
 * joined by a space — or, when they do not fit in 200 characters, "3 documents need approval."
 */
export function approvalReason(waiting: readonly { index: number; reason: string }[]): string {
  const line = waiting.map(({ index, reason }) => `Document ${index}: ${reason}.`).join(' ');
  if (line.length <= REASON_MAXIMUM) return line;
  const n = waiting.length;
  return n === 1 ? '1 document needs approval.' : `${n} documents need approval.`;
}
