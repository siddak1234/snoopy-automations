import { QUICKBOOKS_NUMBER_LENGTH, cleanText } from '@autom8x/automation-kit/values';

import type { Route } from '../document.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import type { DocumentState } from '../state.js';
import type { LookupKey, VendorState } from './contract.js';

/**
 * The lookups' one table (Group 4's change to decide's contract): which of the record lookups —
 * steps 14–17 — runs for a document, says "Not checked", or is skipped, per route (the plan's §5).
 * The lookup steps read it to know what to do, and decide's contract to know what it must find in
 * the state, so the two cannot drift apart.
 */

/**
 * How a lookup step meets a document: it runs its query and writes its key; it applies, but there
 * is no number QuickBooks could hold to search for (none read, or over 21 characters: G4-4), so its
 * line says "Not checked" and it writes nothing; or it does not apply — skipped, no line.
 */
export type LookupUse = 'run' | 'not_checked' | 'skip';

/**
 * A number QuickBooks could hold as a record's own (`DocNumber`, "maximum of 21 chars"): only such
 * a number is searched, since a longer one can be no record's and QuickBooks may refuse the value
 * outright (G4-4).
 */
export const searchableNumber = (number: string): boolean =>
  number.length <= QUICKBOOKS_NUMBER_LENGTH;

/**
 * The invoice numbers a statement lists, each once, as first written: Intuit compares without case,
 * so one listed twice, in any case, is one invoice — counted once in decide's (b), and sent once in
 * the IN list, which repeats none.
 */
export function listedInvoiceNumbers(document: DocumentState): string[] {
  const numbers = new Map<string, string>();
  for (const row of document.statement?.rows ?? []) {
    const folded = cleanText(row.reference)?.toLowerCase() ?? '';
    if (row.kind === 'invoice' && !numbers.has(folded)) numbers.set(folded, row.reference);
  }
  return [...numbers.values()];
}

/**
 * Each lookup's use per route, from what the document and the vendor are (the plan's §5):
 * - a number lookup only for a number QuickBooks could hold — a receipt's only for a seller already
 *   a vendor, a purchase paid personally only for a bill document; a statement's when it lists
 *   invoices, searching those QuickBooks could hold — when it holds none, "Not checked", and each
 *   counts as not in QuickBooks;
 * - an amount lookup on every route;
 * - a related lookup for a bill's number, a receipt, a payer, and — from a linked vendor — a
 *   credit's original invoice number, "Not checked" past the 21 characters a bill's number holds,
 *   so the category is not the original bill's (D25);
 * - the other-record lookup (D32) for a bill — only while expenses are searched by amount (S4's
 *   fallback drops it) — and for a company receipt;
 * - nothing at all for a vendor credit or a statement whose vendor is not in QuickBooks: their
 *   lookups need the vendor, and decide fails them (F5, F6).
 *
 * A seller that is not linked — an inactive vendor's name, or two vendors' — is a seller with no
 * vendor: a receipt's number lookup and a card refund's related lookup are skipped.
 */
export function lookupUses(
  route: Route,
  document: DocumentState,
  vendor: VendorState | null,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): Readonly<Record<LookupKey, LookupUse>> {
  const linked = vendor?.status === 'matched';
  const byNumber: LookupUse = document.numberUsable ? 'run' : 'not_checked';
  const when = (applies: boolean, use: LookupUse = 'run'): LookupUse => (applies ? use : 'skip');
  const original = document.originalInvoiceNumber;
  const byOriginal = when(
    original !== null,
    original !== null && searchableNumber(original) ? 'run' : 'not_checked',
  );
  const uses = (
    numberLookup: LookupUse,
    relatedLookup: LookupUse,
    otherRecordLookup: LookupUse = 'skip',
  ) => ({ numberLookup, amountLookup: 'run' as const, relatedLookup, otherRecordLookup });
  switch (route) {
    case 'bill':
      return uses(byNumber, byNumber, when(expenseSearch === 'amount'));
    case 'company_receipt':
      return uses(when(linked, byNumber), 'run', 'run');
    case 'card_refund':
      return uses(byNumber, when(linked, byOriginal));
    case 'employee':
    case 'owner':
    case 'contractor':
      return uses(when(document.type === 'bill', byNumber), 'run');
    case 'vendor_credit':
    case 'statement': {
      if (!linked) {
        return {
          numberLookup: 'skip',
          amountLookup: 'skip',
          relatedLookup: 'skip',
          otherRecordLookup: 'skip',
        };
      }
      if (route === 'vendor_credit') return uses(byNumber, byOriginal);
      const listed = listedInvoiceNumbers(document);
      return uses(
        when(listed.length > 0, listed.some(searchableNumber) ? 'run' : 'not_checked'),
        'skip',
      );
    }
  }
}

/** The lookups a route needs to have run — its `lookupUses` that run — amount first. */
export function requiredLookups(
  route: Route,
  document: DocumentState,
  vendor: VendorState | null,
  expenseSearch: ExpenseSearch = EXPENSE_SEARCH,
): readonly LookupKey[] {
  const uses = lookupUses(route, document, vendor, expenseSearch);
  const order: readonly LookupKey[] = [
    'amountLookup',
    'numberLookup',
    'relatedLookup',
    'otherRecordLookup',
  ];
  return order.filter((key) => uses[key] === 'run');
}
