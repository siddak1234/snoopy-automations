import {
  LINE_MAXIMUM,
  cleanText,
  fitLine,
  formatMoney,
  shorten,
  type LinePiece,
} from '@autom8x/automation-kit/values';
import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type { ExpenseRow, FoundRecord, LookupKey, VendorState } from '../decide/contract.js';
import { listedInvoiceNumbers } from '../decide/lookup-uses.js';
import { listedNotFound } from '../decide/statement.js';
import type { DocumentState } from '../state.js';
import type { ExpenseSearch } from './expense-search.js';
import { feedWindow } from './queries.js';

/**
 * The record lookups' timeline lines (steps 14–17), each at most 200 characters: what was searched,
 * then what QuickBooks has — each record by its Id, the vendor or account QuickBooks names (a
 * bill's expenses with its number: how each was paid, and to whom), its date and amount — or "none
 * in QuickBooks". They inform the approver; decide weighs the records.
 * Never a line item or a memo: the document's number, the amounts, the dates and QuickBooks' own
 * names alone.
 */

/** What a lookup found, as its line describes it. */
export interface Found {
  readonly document: DocumentState;
  readonly vendor: VendorState | null;
  readonly how: ExpenseSearch;
  /** QuickBooks' rows, for the names they give, beside the records read from them. */
  readonly rows: readonly JsonObject[];
  readonly records: readonly FoundRecord[];
  readonly reachedMax: boolean;
}

/** A document's number inside a line: cut to 30, as decide's lines cut it. */
const numberOf = (number: string | null) => `'${shorten(number ?? '', 30)}'`;
const money = (cents: number) => formatMoney(cents);

/** A reference's name, as QuickBooks gives it: `{ value, name }`. */
function refName(value: unknown): string | null {
  return isObject(value) ? cleanText(value.name) : null;
}

/**
 * One record, as a line lists it: "Id 145 (this vendor, 2026-09-14, $412.50, open)" — an expense by
 * the account it was paid from, or with `payment` by how it was paid and to whom.
 */
function recordPieces(
  record: FoundRecord,
  row: JsonObject,
  vendor: VendorState | null,
  payment: boolean,
): LinePiece[] {
  const ownVendor = vendor?.status === 'matched' ? vendor.id : null;
  const vendorOf = (vendorId: string): LinePiece =>
    vendorId === ownVendor ? 'this vendor' : { name: refName(row.VendorRef) ?? 'another vendor' };
  switch (record.kind) {
    case 'bill':
      return [
        `Id ${shorten(record.id, 20)} (`,
        vendorOf(record.vendorId),
        `, ${record.txnDate}, ${money(record.totalCents)}, ${record.balanceCents === 0 ? 'paid' : 'open'})`,
      ];
    case 'expense':
      if (payment) return paymentPieces(record, row);
      return [
        `Id ${shorten(record.id, 20)} (`,
        { name: refName(row.AccountRef) ?? 'an account' },
        `, ${record.txnDate}, ${money(record.totalCents)}${record.credit ? ', a refund' : ''})`,
      ];
    case 'vendor_credit':
      return [
        `Id ${shorten(record.id, 20)} (`,
        vendorOf(record.vendorId),
        `, ${record.txnDate}, ${money(record.totalCents)})`,
      ];
    case 'journal_entry':
      return [`Id ${shorten(record.id, 20)} (${record.txnDate})`];
  }
}

/** Intuit's `Purchase.PaymentType`: "Type can be Cash, Check, or CreditCard." */
const PAYMENT_TYPES: ReadonlySet<unknown> = new Set(['Cash', 'Check', 'CreditCard']);

/**
 * An expense by how it was paid and to whom — "Id 139 (Check to Pacific Gas, 2026-08-02,
 * $1,200.00)", "(Cash, no payee, …)", "(CreditCard refund from …, …)" — for a bill's expenses with
 * its number (decision 6): any payee's is held (G4-5), so the approver sees a check to someone else
 * that only shares the number (ip-review design-quickbooks-lookups.json steps[7] logic[7]).
 */
function paymentPieces(record: ExpenseRow, row: JsonObject): LinePiece[] {
  const how = `${PAYMENT_TYPES.has(row.PaymentType) ? String(row.PaymentType) : 'Expense'}${
    record.credit ? ' refund' : ''
  }`;
  const payee = refName(row.EntityRef);
  return [
    `Id ${shorten(record.id, 20)} (${how}`,
    ...(payee === null ? [', no payee'] : [record.credit ? ' from ' : ' to ', { name: payee }]),
    `, ${record.txnDate}, ${money(record.totalCents)})`,
  ];
}

/** The fewest characters pieces take with their words whole: each name cut down to one character. */
const leastLength = (pieces: readonly LinePiece[]) =>
  pieces.reduce((total, piece) => total + (typeof piece === 'string' ? piece.length : 1), 0);

/**
 * "<head>: none in QuickBooks", or the first three records, "+N more", and "maybe more" when full;
 * `payment` lists expenses by how each was paid and to whom. As a statement's line keeps its
 * ending, "+N more" and "maybe more" — a full answer's mark (D6) — always end the line whole: the
 * records are fitted to the room they leave, names shortened first, and a record whose words do not
 * fit is left out from the end and counted in "+N more" — the first always shown, and cut only when
 * it alone is too long.
 */
function listLine(
  head: string,
  found: Found,
  { full = 'maybe more', payment = false }: { full?: string; payment?: boolean } = {},
): string {
  const { records } = found;
  if (records.length === 0) return `${head}: none in QuickBooks`;
  const marker = found.reachedMax ? `; ${full}` : '';
  for (let shown = Math.min(records.length, 3); ; shown -= 1) {
    const pieces: LinePiece[] = [`${head}: `];
    records.slice(0, shown).forEach((record, index) => {
      if (index > 0) pieces.push('; ');
      pieces.push(...recordPieces(record, found.rows[index] ?? {}, found.vendor, payment));
    });
    const more = records.length - shown;
    const tail = `${more > 0 ? `; +${more} more` : ''}${marker}`;
    const room = LINE_MAXIMUM - tail.length;
    if (shown === 1 || leastLength(pieces) <= room) return `${fitLine(pieces, room)}${tail}`;
  }
}

/** The bank-feed expenses' line: by amount (D21), or under S4's fallback the window read in code. */
function feedLine(found: Found): string {
  const { document, how } = found;
  const { from, to } = feedWindow(document.date ?? '');
  const amount = money(document.amountCents ?? 0);
  if (how === 'amount') return listLine(`Expenses for ${amount} from ${from} to ${to}`, found);
  const same = found.records.filter(
    (record) => record.kind === 'expense' && record.totalCents === document.amountCents,
  );
  const head = `Expenses from ${from} to ${to}: ${found.records.length} read, ${same.length} for ${amount}`;
  return found.reachedMax ? `${head}; too many expenses to check` : head;
}

/** find-duplicate-number's line; a statement's lists its invoice numbers QuickBooks lacks. */
export function numberLine(found: Found): string {
  const { document } = found;
  switch (document.route) {
    case 'statement':
      return missingLine(found);
    case 'company_receipt':
      return listLine(`Bills from this vendor with number ${numberOf(document.number)}`, found);
    case 'card_refund':
    case 'vendor_credit':
      return listLine(`Vendor credits with number ${numberOf(document.number)}`, found);
    default:
      return listLine(`Bills with number ${numberOf(document.number)}`, found);
  }
}

/**
 * A statement's listed invoice numbers that are not among this vendor's bills — decide's (b), each
 * once — as many as fit in 200 characters, then "+N more" (the plan's §2.6); the full list is in
 * the run's output.
 */
function missingLine(found: Found): string {
  const vendorId = found.vendor?.status === 'matched' ? found.vendor.id : '';
  const listed = listedInvoiceNumbers(found.document);
  const missing = listedNotFound(found.document, found, vendorId);
  const full = found.reachedMax ? '; too many bills to check' : '';
  if (missing.length === 0) {
    return `All ${listed.length} listed invoice numbers are on this vendor's bills in QuickBooks${full}`;
  }
  const head = 'Listed invoices not in QuickBooks: ';
  const shown: string[] = [];
  for (const [index, number] of missing.entries()) {
    const rest = missing.length - index - 1;
    const next = [...shown, shorten(number, 30)].join(', ');
    const tail = rest > 0 ? ` +${rest} more` : '';
    if ((head + next + tail + full).length > LINE_MAXIMUM) break;
    shown.push(shorten(number, 30));
  }
  const left = missing.length - shown.length;
  return `${head}${shown.join(', ')}${left > 0 ? ` +${left} more` : ''}${full}`;
}

/** find-duplicate-amount's line, per route. */
export function amountLine(found: Found): string {
  const { document, vendor } = found;
  const amount = money(document.amountCents ?? 0);
  switch (document.route) {
    case 'bill':
    case 'contractor': {
      const whose = vendor?.status === 'matched' ? ' from this vendor' : '';
      return listLine(`Bills${whose} for ${amount} on ${document.date}`, found);
    }
    case 'company_receipt':
    case 'card_refund':
      return feedLine(found);
    case 'employee':
    case 'owner':
      return listLine(`Journal entries on ${document.date}`, found);
    case 'vendor_credit':
      return listLine(`Vendor credits for ${amount} on ${document.date}`, found);
    case 'statement': {
      const open = found.records.reduce(
        (sum, record) => sum + (record.kind === 'bill' ? record.balanceCents : 0),
        0,
      );
      const head =
        found.records.length === 0
          ? 'Open bills from this vendor: none in QuickBooks'
          : `Open bills from this vendor: ${found.records.length}, ${money(open)} open in all`;
      return found.reachedMax ? `${head}; maybe more` : head;
    }
  }
}

/** find-related's line, per route. */
export function relatedLine(found: Found): string {
  const { document } = found;
  switch (document.route) {
    case 'bill':
      return listLine(`Expenses with number ${numberOf(document.number)}`, found, {
        payment: true,
      });
    case 'company_receipt':
      return listLine(`Bills for ${money(document.amountCents ?? 0)}, newest first`, found);
    case 'card_refund':
    case 'vendor_credit':
      return listLine(
        `Bills from this vendor with number ${numberOf(document.originalInvoiceNumber)}`,
        found,
      );
    default:
      return feedLine(found);
  }
}

/** find-other-record's line (D32). */
export function otherRecordLine(found: Found): string {
  const { document } = found;
  if (document.route === 'company_receipt') {
    const { from, to } = feedWindow(document.date ?? '');
    return listLine(`Journal entries from ${from} to ${to}`, found);
  }
  return listLine(`Expenses for ${money(document.amountCents ?? 0)} near this bill's dates`, found);
}

/**
 * A lookup that applies but has no number QuickBooks could hold to search for (G4-4): the
 * document's own number, a credit's original invoice number (its category then is not the original
 * bill's, D25), or every invoice number a statement lists (each then not in QuickBooks).
 */
export function notCheckedLine(document: DocumentState, key: LookupKey): string {
  if (document.route === 'statement') {
    return 'Not checked by number: every invoice number the statement lists is longer than the 21 characters QuickBooks holds, so none is in QuickBooks';
  }
  if (key === 'relatedLookup' && document.type === 'credit_note') {
    return 'Original bill not checked: its number is longer than the 21 characters QuickBooks holds';
  }
  return document.number === null
    ? 'Not checked by number: no number was read'
    : 'Not checked by number: the number is longer than the 21 characters QuickBooks holds';
}
