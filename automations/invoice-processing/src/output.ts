import type { InvokeRequest, JsonObject, RunDetail } from '@autom8x/automation-sdk';

import type { SavedState } from './decide/saved.js';
import { statementLine, type StatementResult } from './decide/statement.js';
import { comparedDetails, recordedDetails, savedDetails } from './details.js';
import { savedDetailsOf, type SavedDetailsState } from './steps/save-details.js';
import { RECORD_WORDS, RESULTS, money } from './words.js';
import type { MailKind } from './writes/mail.js';
import { nextStepOf, payeeNameOf } from './writes/lines.js';
import {
  createdOf,
  newVendorOf,
  readSaved,
  statementOf,
  type CreatedState,
  type NewVendorState,
} from './writes/saved-state.js';

/**
 * The run's result once its pipeline ends (the plan's §5, "Output"; v2's §2.8 — the manifest's
 * `outputSchema` describes it); a held run ends at decide instead, with no result of this kind.
 * Each has a one-line summary (§3.F) and the `details` a person reads on the run (`src/details.ts`).
 *
 * - **A statement compared** (`outcome: 'compared'`): what decide found — its own sum, the vendor's
 *   open bills it does not list, its balance against QuickBooks' — with the full list of the
 *   invoice numbers it lists that QuickBooks lacks, and whether each lookup read all there was.
 * - **A record made** (`outcome: 'recorded'`), straight through or after an approval: the
 *   document's type and route; the record's type and QuickBooks Id, its payment type, the amount
 *   sent and the total QuickBooks shows, its date, due date and number, its payee, its category and
 *   the account it was paid from; the next step; why it was held, if it was; and how it was decided.
 * - **The details saved** (`outcome: 'saved'`): the vendor "None", or QuickBooks did not record it
 *   — `notRecorded` says why; null when QuickBooks was not chosen, or did not confirm.
 *
 * It NEVER throws once a record is made: a throw there would mark failed a run whose record exists.
 */

export interface RunOutcome {
  readonly output: JsonObject;
  readonly summary: string;
  readonly details: readonly RunDetail[];
  /** What notify's mail says it is about (`src/writes/mail.ts`). */
  readonly mail: MailKind;
}

function compared(result: StatementResult): RunOutcome {
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
    },
    summary: statementLine(result),
    details: comparedDetails(result),
    mail: { kind: 'compared', vendor: result.vendor.displayName },
  };
}

/** The payee the record names: a planned new vendor as the vendor it became. */
function payeeOf(saved: SavedState, newVendor: NewVendorState | null): JsonObject {
  const { payee } = saved.plan;
  return payee.kind === 'new_vendor' && newVendor !== null
    ? { kind: 'vendor', id: newVendor.id, name: newVendor.displayName }
    : { ...payee };
}

/** A record made, as its result line (§3.F) and its mail name it: the noun, the vendor — the seller when it names none — and the total. */
function recordedMail(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
): Extract<MailKind, { kind: 'recorded' }> {
  return {
    kind: 'recorded',
    noun: RECORD_WORDS[saved.plan.record].noun,
    vendor: payeeNameOf(saved, created, newVendor) ?? saved.seller,
    total: money(created.totalCents ?? saved.plan.amountCents),
  };
}

function recorded(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
  request: InvokeRequest,
): RunOutcome {
  const { plan } = saved;
  const decidedBy = request.continuation ? 'after approval' : 'automatically';
  const mail = recordedMail(saved, created, newVendor);
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
      nextStep: nextStepOf(saved),
      holdReasons: [...saved.holdReasons],
      decidedBy,
    },
    summary: RESULTS.recorded(mail.noun, mail.vendor, mail.total),
    details: recordedDetails(saved, created, newVendor, decidedBy),
    mail,
  };
}

/** The result line of the details saved (§3.F). */
export function savedSummary(saved: SavedDetailsState): string {
  if (saved.unconfirmed) return RESULTS.unconfirmed;
  if (saved.notRecorded !== null) return RESULTS.notRecorded(saved.notRecorded);
  return RESULTS.saved(
    saved.seller,
    saved.totalCents === null ? null : money(saved.totalCents, saved.currency),
  );
}

function savedResult(saved: SavedDetailsState): RunOutcome {
  const { notRecorded, unconfirmed, ...read } = saved;
  const total = read.totalCents === null ? null : money(read.totalCents, read.currency);
  return {
    output: { outcome: 'saved', ...read, notRecorded },
    summary: savedSummary(saved),
    mail: { kind: 'saved', seller: read.seller, total },
    details: savedDetails(
      read,
      unconfirmed ? { unconfirmed: true } : notRecorded === null ? null : { notRecorded },
    ),
  };
}

/** The run's output, summary and details from what its steps left; a state that holds none is a fault. */
export function runResult(state: JsonObject, request: InvokeRequest): RunOutcome {
  const saved = savedDetailsOf(state);
  if (saved) return savedResult(saved);
  const statement = statementOf(state);
  if (statement) return compared(statement);
  const created = createdOf(state);
  if (created) {
    const plan = readSaved(state);
    const newVendor = newVendorOf(state);
    if (plan && newVendor !== undefined) return recorded(plan, created, newVendor, request);
    // A guard that should never fire: the record stands, named as far as the state says.
    const words = RECORD_WORDS[created.record as keyof typeof RECORD_WORDS];
    const total = typeof created.totalCents === 'number' ? money(created.totalCents) : '';
    return {
      output: { outcome: 'recorded', record: { type: created.record, id: created.id } },
      summary:
        words === undefined ? 'Recorded in QuickBooks.' : `Recorded in QuickBooks: ${words.noun}.`,
      details: words === undefined ? [] : [{ label: 'Recorded as', value: words.recordedAs }],
      mail: {
        kind: 'recorded',
        noun: words?.noun ?? 'record',
        vendor: created.payeeName ?? '',
        total,
      },
    };
  }
  throw new Error('the run ended without a decision');
}
