import { type InvokeRequest, type JsonObject } from '@autom8x/automation-sdk';

import type { SavedState } from './decide/saved.js';
import { statementLine, type StatementResult } from './decide/statement.js';
import { NOUNS, nextStepOf, recordedLine } from './writes/lines.js';
import {
  createdOf,
  newVendorOf,
  readSaved,
  statementOf,
  type CreatedState,
  type NewVendorState,
} from './writes/saved-state.js';

/**
 * The run's result once its pipeline ends (the plan's §5, "Output"; the manifest's `outputSchema`
 * describes it); a held run ends at decide instead, with no result of this kind.
 *
 * - **A statement compared** (`outcome: 'compared'`): what decide found — its own sum, the vendor's
 *   open bills it does not list, its balance against QuickBooks' — with the FULL list of the
 *   invoice numbers it lists that QuickBooks lacks, which neither app shows yet, and whether each
 *   lookup read all there was (`listedCheckable`, `openBillsCheckable`: false at its maximum, D6);
 *   the summary is decide's line, the totals and the counts.
 * - **A record made** (`outcome: 'recorded'`), straight through or after an approval: the
 *   document's type and route; the record's type and QuickBooks Id, its payment type, the amount
 *   sent and the total QuickBooks shows, its date, due date and number, its payee — a new vendor's
 *   QuickBooks Id once found or added — its category and Paid from account; who paid; the next
 *   step; why it was held, if it was; and whether it was decided automatically or after approval.
 *   The summary is create-record's line: what was recorded, and the next step.
 *
 * It NEVER throws once a record is made: a throw there would mark failed a run whose record
 * exists. A state with `created` that does not read back — a guard that should never fire, since
 * create-record read it whole moments before — still answers with the record's type and Id.
 */

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
        openBillsCheckable: result.openBillsCheckable,
        quickBooksOpenCents: result.quickBooksOpenCents,
        differenceCents: result.differenceCents,
      },
      secondCheck: result.secondCheck,
      switchIgnored: result.switchIgnored,
    },
    summary: statementLine(result),
  };
}

/** The payee the record names: a planned new vendor as the vendor it became. */
function payeeOf(saved: SavedState, newVendor: NewVendorState | null): JsonObject {
  const { payee } = saved.plan;
  return payee.kind === 'new_vendor' && newVendor !== null
    ? { kind: 'vendor', id: newVendor.id, name: newVendor.displayName }
    : { ...payee };
}

function recorded(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
  request: InvokeRequest,
): { output: JsonObject; summary: string } {
  const { plan } = saved;
  return {
    output: {
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
      payer: saved.payer === null ? null : { ...saved.payer },
      nextStep: nextStepOf(saved),
      holdReasons: [...saved.holdReasons],
      decidedBy: request.continuation ? 'after approval' : 'automatically',
    },
    summary: recordedLine(saved, created, newVendor),
  };
}

/** The run's output and summary from what its steps left; a state that holds neither is a fault. */
export function runResult(
  state: JsonObject,
  request: InvokeRequest,
): { output: JsonObject; summary: string } {
  const statement = statementOf(state);
  if (statement) return compared(statement);
  const created = createdOf(state);
  if (created) {
    const saved = readSaved(state);
    const newVendor = newVendorOf(state);
    if (saved && newVendor !== undefined) return recorded(saved, created, newVendor, request);
    const noun = NOUNS[created.record] ?? 'record';
    return {
      output: { outcome: 'recorded', record: { type: created.record, id: created.id } },
      summary: `Recorded ${noun} ${created.id.slice(0, 20)} in QuickBooks.`,
    };
  }
  throw new Error('the run ended without a decision');
}
