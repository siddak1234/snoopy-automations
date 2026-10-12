import { cleanText, formatMoney, withinOneCent } from '@autom8x/automation-kit/values';

import type { DocumentState } from '../state.js';
import type { BillRow, DecideState, LookupState } from './contract.js';
import { listedInvoiceNumbers } from './lookup-uses.js';
import { joinWithin } from './words.js';

/**
 * A supplier's statement, compared with QuickBooks (the plan's §2.5 "Statement" and §2.6; D26):
 * information only — nothing is written and the run never holds. decide reports:
 * (a) its own sum, when its list is complete, against its closing balance;
 * (b) the invoice numbers it lists that are not among the vendor's bills — each once, whatever its
 *     case, as the IN query sends it; one longer than the 21 characters a bill's number holds is
 *     not searched, so it counts here;
 * (c) the vendor's open bills it does not list, only when its list is complete;
 * (d) its closing balance against what QuickBooks shows the company owes the vendor.
 */

export interface StatementResult {
  readonly v: 1;
  readonly documentType: 'supplier_statement';
  readonly route: 'statement';
  readonly vendor: { readonly id: string; readonly displayName: string };
  readonly closingCents: number | null;
  /** (a) */
  readonly ownSum: 'adds_up' | 'differs' | 'incomplete' | 'not_read';
  readonly ownSumDifferenceCents: number | null;
  /** (b) the full list, which the run's output carries (the line shows the count). */
  readonly listedNotInQuickBooks: readonly string[];
  /** False when the lookup reached its maximum: the list above may hold numbers QuickBooks has. */
  readonly listedCheckable: boolean;
  /** (c) null when the statement's list is not complete. */
  readonly openBillsNotListed: { readonly count: number; readonly totalCents: number } | null;
  /** False when the open-bills lookup reached its maximum: more open bills may be unseen (D6). */
  readonly openBillsCheckable: boolean;
  /** (d) */
  readonly quickBooksOpenCents: number | null;
  readonly differenceCents: number | null;
  readonly secondCheck: 'made' | 'not_made';
  /** The switch was on; it does not apply to a statement. */
  readonly switchIgnored: boolean;
}

const fold = (value: string | null) => cleanText(value)?.toLowerCase() ?? null;

/** The vendor's bills a lookup found. */
const vendorBills = (lookup: LookupState | null, vendorId: string): BillRow[] =>
  (lookup?.records ?? []).filter(
    (record): record is BillRow => record.kind === 'bill' && record.vendorId === vendorId,
  );

/**
 * (b): the invoice numbers the statement lists — each once, whatever its case — that are not among
 * the vendor's bills its number lookup found; one too long to search is never found. decide's
 * count, the run's output and find-duplicate-number's line all take it from here.
 */
export function listedNotFound(
  document: DocumentState,
  numberLookup: LookupState | null,
  vendorId: string,
): string[] {
  const known = new Set(vendorBills(numberLookup, vendorId).map((bill) => fold(bill.docNumber)));
  return listedInvoiceNumbers(document).filter((reference) => !known.has(fold(reference)));
}

export function statementResult(state: DecideState, switchOn: boolean): StatementResult {
  const { document, vendor, numberLookup, amountLookup, verification } = state;
  if (vendor?.status !== 'matched') throw new Error('a statement is compared only with a vendor');
  const rows = document.statement?.rows ?? [];
  const complete = document.statement?.complete === true;
  const closing = document.totalCents;
  const own = document.statement?.ownSumCents ?? null;
  const ownSum =
    !complete || own === null
      ? closing === null
        ? 'not_read'
        : 'incomplete'
      : withinOneCent(own, closing ?? own)
        ? 'adds_up'
        : 'differs';
  const missing = listedNotFound(document, numberLookup, vendor.id);
  const listedFolded = new Set(rows.map((row) => fold(row.reference)));
  const open = vendorBills(amountLookup, vendor.id).filter(
    (bill) => bill.balanceCents > 0 && !listedFolded.has(fold(bill.docNumber)),
  );
  const quickBooksOpen = vendor.balanceCents;
  return {
    v: 1,
    documentType: 'supplier_statement',
    route: 'statement',
    vendor: { id: vendor.id, displayName: vendor.displayName },
    closingCents: closing,
    ownSum,
    ownSumDifferenceCents:
      ownSum === 'differs' && closing !== null && own !== null ? own - closing : null,
    listedNotInQuickBooks: missing,
    listedCheckable: numberLookup?.reachedMax !== true,
    openBillsNotListed: complete
      ? { count: open.length, totalCents: open.reduce((sum, bill) => sum + bill.balanceCents, 0) }
      : null,
    openBillsCheckable: amountLookup?.reachedMax !== true,
    quickBooksOpenCents: quickBooksOpen,
    differenceCents: closing !== null && quickBooksOpen !== null ? closing - quickBooksOpen : null,
    secondCheck: verification.status === 'made' ? 'made' : 'not_made',
    switchIgnored: switchOn,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * decide's line for a statement, at most 200 characters, with "Nothing was created." always kept:
 * "Statement balance $1,250.00; QuickBooks shows $980.00 open (differs by $270.00); 2 listed
 * invoices not in QuickBooks. Nothing was created." What does not fit is in the run's output.
 */
export function statementLine(result: StatementResult): string {
  const parts: string[] = [];
  parts.push(
    result.closingCents === null
      ? 'Statement balance not read'
      : `Statement balance ${formatMoney(result.closingCents)}`,
  );
  if (result.quickBooksOpenCents !== null) {
    const difference = result.differenceCents ?? 0;
    parts.push(
      `QuickBooks shows ${formatMoney(result.quickBooksOpenCents)} open${
        result.closingCents === null
          ? ''
          : difference === 0
            ? ' (the same)'
            : ` (differs by ${formatMoney(Math.abs(difference))})`
      }`,
    );
  }
  const missing = result.listedNotInQuickBooks.length;
  if (missing > 0) {
    const words = `${plural(missing, 'listed invoice', 'listed invoices')} not in QuickBooks`;
    parts.push(result.listedCheckable ? words : `${words} (too many to check)`);
  }
  if (result.openBillsNotListed !== null && result.openBillsNotListed.count > 0) {
    const words = `${plural(result.openBillsNotListed.count, 'open bill', 'open bills')} not on it (${formatMoney(result.openBillsNotListed.totalCents)})`;
    parts.push(result.openBillsCheckable ? words : `${words} (too many to check)`);
  }
  if (result.ownSum === 'differs' && result.ownSumDifferenceCents !== null) {
    parts.push(`its own rows differ by ${formatMoney(Math.abs(result.ownSumDifferenceCents))}`);
  }
  if (result.ownSum === 'incomplete') parts.push('its list is not complete');
  if (result.secondCheck === 'not_made') parts.push('second check not made');
  if (result.switchIgnored) parts.push("the switch doesn't apply to a statement");
  return joinWithin(parts, '. Nothing was created.');
}
