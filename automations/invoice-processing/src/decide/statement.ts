import { cleanText, formatMoney, withinOneCent } from '@autom8x/automation-kit/values';

import type { DecideState } from './contract.js';
import { joinWithin } from './words.js';

/**
 * A supplier's statement, compared with QuickBooks (the plan's §2.5 "Statement" and §2.6; D26):
 * information only — nothing is written and the run never holds. decide reports:
 * (a) its own sum, when its list is complete, against its closing balance;
 * (b) the invoice numbers it lists that are not among the vendor's bills;
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
  /** (d) */
  readonly quickBooksOpenCents: number | null;
  readonly differenceCents: number | null;
  readonly secondCheck: 'made' | 'not_made';
  /** The switch was on; it does not apply to a statement. */
  readonly switchIgnored: boolean;
}

const fold = (value: string | null) => cleanText(value)?.toLowerCase() ?? null;

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
  const bills = (lookup: typeof numberLookup) =>
    (lookup?.records ?? []).filter(
      (record): record is Extract<typeof record, { kind: 'bill' }> =>
        record.kind === 'bill' && record.vendorId === vendor.id,
    );
  const known = new Set(bills(numberLookup).map((bill) => fold(bill.docNumber)));
  const listed = rows.filter((row) => row.kind === 'invoice').map((row) => row.reference);
  const missing = listed.filter((reference) => !known.has(fold(reference)));
  const listedFolded = new Set(rows.map((row) => fold(row.reference)));
  const open = bills(amountLookup).filter(
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
    parts.push(
      `${plural(result.openBillsNotListed.count, 'open bill', 'open bills')} not on it (${formatMoney(result.openBillsNotListed.totalCents)})`,
    );
  }
  if (result.ownSum === 'differs' && result.ownSumDifferenceCents !== null) {
    parts.push(`its own rows differ by ${formatMoney(Math.abs(result.ownSumDifferenceCents))}`);
  }
  if (result.ownSum === 'incomplete') parts.push('its list is not complete');
  if (result.secondCheck === 'not_made') parts.push('second check not made');
  if (result.switchIgnored) parts.push("the switch doesn't apply to a statement");
  return joinWithin(parts, '. Nothing was created.');
}
