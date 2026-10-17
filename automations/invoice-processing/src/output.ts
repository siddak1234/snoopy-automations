import type { JsonObject } from '@autom8x/automation-sdk';

import type { SavedState } from './decide/saved.js';
import type { StatementResult } from './decide/statement.js';
import { nextStepOf } from './writes/lines.js';
import type { CreatedState, NewVendorState } from './writes/saved-state.js';

/**
 * One document's structured result (the plan's §5, "Output"; v2's §2.8, each item of v3's
 * `outputSchema`): what QuickBooks answered and what was decided — the platform keeps it with the
 * run and does not publish it; what was read is in the run's documents, which it does.
 *
 * - **A statement compared** (`outcome: 'compared'`): what decide found — its own sum, the vendor's
 *   open bills it does not list, its balance against QuickBooks' — with the full list of the
 *   invoice numbers it lists that QuickBooks lacks, and whether each lookup read all there was.
 * - **A record made** (`outcome: 'recorded'`), straight through or after an approval: the
 *   document's type and route; the record's type and QuickBooks Id, its payment type, the amount
 *   sent and the total QuickBooks shows, its date, due date and number, its payee, its category and
 *   the account it was paid from; the next step; why it was held, if it was; and how it was decided.
 *
 * It NEVER throws once a record is made: a throw there would mark failed a run whose record exists.
 */

export function comparedOutput(result: StatementResult): JsonObject {
  return {
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
      openBillsCheckable: result.openBillsCheckable,
      quickBooksOpenCents: result.quickBooksOpenCents,
      differenceCents: result.differenceCents,
    },
    secondCheck: result.secondCheck,
  };
}

/** The payee the record names: a planned new vendor as the vendor it became. */
function payeeOf(saved: SavedState, newVendor: NewVendorState | null): JsonObject {
  const { payee } = saved.plan;
  return payee.kind === 'new_vendor' && newVendor !== null
    ? { kind: 'vendor', id: newVendor.id, name: newVendor.displayName }
    : { ...payee };
}

export function recordedOutput(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
  decidedBy: 'automatically' | 'after approval',
): JsonObject {
  const { plan } = saved;
  return {
    outcome: 'recorded',
    documentType: saved.documentType,
    route: saved.route,
    record: {
      type: plan.record,
      id: created.id,
      operation: plan.operation,
      paymentType: plan.paymentType,
      amountCents: plan.amountCents,
      quickBooksTotalCents: created.totalCents,
      date: created.txnDate,
      dueDate: created.dueDate,
      docNumber: created.docNumber,
      documentNumber: saved.documentNumber,
      payee: payeeOf(saved, newVendor),
      category: { ...plan.accounts.category },
      paidFromAccount: plan.accounts.paidFrom === null ? null : { ...plan.accounts.paidFrom },
    },
    newVendor: newVendor === null ? null : { ...newVendor },
    nextStep: nextStepOf(saved),
    holdReasons: [...saved.holdReasons],
    decidedBy,
  };
}
