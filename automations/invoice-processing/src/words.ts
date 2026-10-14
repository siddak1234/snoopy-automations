import { formatMoney, shorten } from '@autom8x/automation-kit/values';

import type { DocumentType, PaymentMethod } from './document.js';
import type { SpendType } from './spend-types.js';

/**
 * The words a person reads (v2; the spec's §3.E and §3.F, final, and the owner's rule of
 * 2026-10-14: short, plain, no codes — "We dont need the users downloading an app to read an
 * essay"). A sentence carries no reason code and nothing from QuickBooks' or a model's own text;
 * the code goes to the log alone (`src/outcome.ts`).
 */

/** Why a run fails, on either path: the document cannot be used, or the run could not go on. */
export const RUN_FAILS = {
  no_file: 'Add a PDF or photo, then start again.',
  C1: 'This is a bank or card statement. Add one bill or receipt.',
  C2: 'This is a quote, not a bill or receipt.',
  C3: 'This is a purchase order, not a bill or receipt.',
  C4: 'This is not a bill, receipt, credit note or statement.',
  C5: 'Add one document per file.',
  C6: 'Pages are missing. Add the whole document.',
  C8: "The seller's name can't be read. Try a clearer photo.",
  C11: "The total can't be read. Try a clearer photo.",
  C21: "The date can't be read. Try a clearer photo.",
  C22: "The date isn't a real date. Try a clearer photo.",
  C26: 'Nothing on this statement can be read. Try a clearer photo.',
  unreadable: "The document can't be read. Try a clearer photo.",
  ai_busy: 'AI is busy. Try again in a minute.',
  ai_unavailable: "The document can't be read right now. Try again.",
  file: "The file couldn't be opened. Add it again.",
  other: 'Something went wrong. Try again.',
} as const;

export type RunFail = keyof typeof RUN_FAILS;

/** A day as a person reads it: `2026-10-02` is `Oct 2, 2026`. */
export function dayWords(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return day;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[Number(match[2]) - 1];
  return month === undefined ? day : `${month} ${Number(match[3])}, ${match[1]}`;
}

/** Cents as a person reads them: `$1,234.56`, or `1,234.56 CAD` in another currency. */
export const money = (cents: number, currency: string | null = null): string =>
  formatMoney(cents, currency ?? 'USD');

/** A seller's or a vendor's name on a line: never more than 60 characters. */
export const nameWords = (name: string): string => shorten(name, 60);

/** The longest timeline line (§3.E): 80 characters. */
export const LINE_MAXIMUM = 80;

/**
 * A timeline line naming a seller, a vendor or a company: the name shortened so the whole line
 * fits in 80 characters, what follows it — a total — kept whole.
 */
export function lineWith(before: string, name: string, after = ''): string {
  const room = Math.min(60, LINE_MAXIMUM - before.length - after.length);
  return shorten(`${before}${shorten(name, Math.max(room, 1))}${after}`, LINE_MAXIMUM);
}

/** What a document is, inside a line: "Read: bill from …". */
export const DOCUMENT_WORDS: Readonly<Record<DocumentType, string>> = {
  bill: 'bill',
  receipt: 'receipt',
  credit_note: 'credit note',
  supplier_statement: 'statement',
  bank_statement: 'bank statement',
  quote: 'quote',
  purchase_order: 'purchase order',
  other: 'document',
};

/** The saved details' "Type" (§2.8). */
export const TYPE_WORDS = {
  bill: 'Bill',
  receipt: 'Receipt',
  credit_note: 'Credit note',
  supplier_statement: 'Statement',
} as const;

/** The spend type as the saved details' "Category" says it (§2.8). */
export const SPEND_TYPE_WORDS: Readonly<Record<SpendType, string>> = {
  meals: 'Meals',
  travel: 'Travel',
  vehicle_and_fuel: 'Vehicle and fuel',
  office_supplies: 'Office supplies',
  software_and_subscriptions: 'Software and subscriptions',
  utilities_and_phone: 'Utilities and phone',
  rent: 'Rent',
  repairs_and_maintenance: 'Repairs and maintenance',
  professional_services: 'Professional services',
  materials: 'Materials',
  advertising: 'Advertising',
  other: 'Other',
};

/**
 * How it was paid, as the saved details' "Paid with" says it (§2.8): a card only with its last
 * four digits; nothing for a way not shown, or one the list has no words for.
 */
export function paidWithWords(method: PaymentMethod, cardLast4: string | null): string | null {
  switch (method) {
    case 'card':
      return cardLast4 === null ? null : `Card ending ${cardLast4}`;
    case 'cash':
      return 'Cash';
    case 'check':
      return 'Check';
    case 'bank_transfer':
      return 'Bank transfer';
    default:
      return null;
  }
}

/** The records this automation makes: the result's noun (§3.F) and "Recorded as" (§2.8). */
export const RECORD_WORDS = {
  bill: { noun: 'bill', recordedAs: 'Bill' },
  expense: { noun: 'expense', recordedAs: 'Expense' },
  vendor_credit: { noun: 'vendor credit', recordedAs: 'Vendor credit' },
  card_refund: { noun: 'card refund', recordedAs: 'Card refund' },
} as const;

export type RecordKind = keyof typeof RECORD_WORDS;

/** The run's result line (§3.F), each ending as a sentence. */
export const RESULTS = {
  saved: (seller: string, total: string | null) =>
    `Saved: ${nameWords(seller)}${total === null ? '' : `, ${total}`}.`,
  notRecorded: (reason: string) => `Saved. Not recorded in QuickBooks: ${reason}.`,
  unconfirmed: "Saved. QuickBooks didn't confirm. Check QuickBooks before you run it again.",
  recorded: (noun: string, vendor: string, total: string) =>
    `Recorded in QuickBooks: ${noun} from ${nameWords(vendor)}, ${total}.`,
  compared: (missing: number) =>
    `Compared with QuickBooks: ${missing} ${missing === 1 ? 'invoice' : 'invoices'} not in QuickBooks.`,
} as const;
