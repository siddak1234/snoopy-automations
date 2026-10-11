import { fitLine, formatMoney, type LinePiece } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type { Payee, RecordPlan } from './decide/plan.js';
import type { SavedState } from './decide/saved.js';
import { statementLine, type StatementResult } from './decide/statement.js';

/**
 * The run's result once its pipeline ends — decide's outcome, which replaced the run's state (the
 * plan's §2.6 and §5, "Output"); a held run ends at decide instead, with no result of this kind.
 *
 * - **A statement compared** (`outcome: 'compared'`): what decide found — its own sum, the vendor's
 *   open bills it does not list, its balance against QuickBooks' — with the FULL list of the
 *   invoice numbers it lists that QuickBooks lacks, which neither app shows yet; the summary is
 *   decide's line, the totals and the counts.
 * - **A record decided** (`outcome: 'planned'`), straight through or approved after a hold: the
 *   document's type and route, the record planned — its type, payment type, amount, date, payee,
 *   category and Paid from account — who paid, and why it was held, if it was. The writes (the
 *   plan's Group 5, steps 19–24) are not in this version, so nothing is written: the summary says
 *   so, and the output carries no record Id yet.
 */

/** decide's statement comparison, as its step left the state. */
function isComparison(state: JsonObject): boolean {
  return (
    state.v === 1 &&
    state.route === 'statement' &&
    Array.isArray(state.listedNotInQuickBooks) &&
    isObject(state.vendor)
  );
}

/** decide's saved plan, as its step left the state — or as an approval handed it back. */
function isSaved(state: JsonObject): boolean {
  return state.v === 1 && typeof state.route === 'string' && isObject(state.plan);
}

function compared(result: StatementResult): { output: JsonObject; summary: string } {
  return {
    output: {
      outcome: 'compared',
      documentType: result.documentType,
      route: result.route,
      vendor: { ...result.vendor },
      statement: {
        closingCents: result.closingCents,
        ownSum: result.ownSum,
        ownSumDifferenceCents: result.ownSumDifferenceCents,
        listedNotInQuickBooks: [...result.listedNotInQuickBooks],
        listedCheckable: result.listedCheckable,
        openBillsNotListed:
          result.openBillsNotListed === null ? null : { ...result.openBillsNotListed },
        quickBooksOpenCents: result.quickBooksOpenCents,
        differenceCents: result.differenceCents,
      },
      secondCheck: result.secondCheck,
      switchIgnored: result.switchIgnored,
    },
    summary: statementLine(result),
  };
}

/** Who the record names, as a person reads it. */
function payeeName(payee: Payee): string | null {
  return payee.kind === 'none' ? null : payee.name;
}

/** What the record is, as the summary words it: "a bill from Harrowgate Office Supply, $413.34". */
function recordWords(plan: RecordPlan): LinePiece[] {
  const amount = formatMoney(plan.amountCents);
  const name = payeeName(plan.payee);
  const paidFrom = plan.accounts.paidFrom?.name ?? '';
  switch (plan.record) {
    case 'bill':
      return ['a bill from ', { name: name ?? '' }, `, ${amount}`];
    case 'expense':
      return [`an expense of ${amount} from `, { name: paidFrom }];
    case 'card_refund':
      return [`a refund of ${amount} to `, { name: paidFrom }];
    case 'vendor_credit':
      return ['a vendor credit from ', { name: name ?? '' }, `, ${amount}`];
    case 'journal_entry':
      return ['a journal entry for what ', { name: name ?? '' }, ` paid, ${amount}`];
  }
}

function planned(saved: SavedState): { output: JsonObject; summary: string } {
  const { plan } = saved;
  return {
    output: {
      outcome: 'planned',
      documentType: saved.documentType,
      route: saved.route,
      record: {
        type: plan.record,
        operation: plan.operation,
        paymentType: plan.paymentType,
        amountCents: plan.amountCents,
        date: plan.date,
        dueDate: plan.dueDate,
        docNumber: plan.docNumber,
        payee: { ...plan.payee },
        category: { ...plan.accounts.category },
        paidFromAccount: plan.accounts.paidFrom === null ? null : { ...plan.accounts.paidFrom },
      },
      payer: saved.payer === null ? null : { ...saved.payer },
      holdReasons: [...saved.holdReasons],
    } as unknown as JsonObject,
    summary: fitLine([
      'Ready to record ',
      ...recordWords(plan),
      '; this version stops before writing to QuickBooks. Nothing was created.',
    ]),
  };
}

/** The run's output and summary from decide's outcome; a state decide did not leave is a fault. */
export function runResult(state: JsonObject): { output: JsonObject; summary: string } {
  if (isComparison(state)) return compared(state as unknown as StatementResult);
  if (isSaved(state)) return planned(state as unknown as SavedState);
  throw new Error('the run ended without a decision');
}
