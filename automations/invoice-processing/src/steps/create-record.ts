import { writeQuickBooks, type QuickBooksWrite } from '@autom8x/automation-kit/quickbooks';
import { cleanText, shorten, toCents } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import type { Payee, RecordPlan } from '../decide/plan.js';
import { noteSentence } from '../failures.js';
import { failedWith } from '../outcome.js';
import { recordBody, writeKindOf } from '../writes/bodies.js';
import { WRITE_NOUNS, recordedLine } from '../writes/lines.js';
import {
  isStatementComparison,
  newVendorOf,
  readSaved,
  vendorCreated,
  type CreatedState,
  type NewVendorState,
} from '../writes/saved-state.js';
import { recordFailure, recordUnconfirmed, stateIncomplete } from '../writes/sentences.js';

/**
 * `create-record` (step 23, was create-bill) — the ONE write: the record decide planned, exactly as
 * saved — straight after decide in a run that did not hold, or after confirm-no-duplicate once an
 * approval resumed it — and nothing for a statement (the plan's §2.6, §2.8, §5 "Writes"):
 *
 * - a bill or a contractor's bill (`bill.create`), an expense or a card refund (`purchase.create`), a
 *   vendor credit (`vendorCredit.create`), an employee's or an owner's journal entry
 *   (`journalEntry.create`) — the platform's P1–P5, each with its `requestid` — its body built from
 *   the saved plan alone (`src/writes/bodies.ts`), never from the settings as they are by then; the
 *   memo names this run, after an approval the continuation;
 * - one request, repeated only by the SDK's step retry when nothing answered — no answer, a
 *   502/503/504 naming no reason — under the same key, so the same `requestid`, which Intuit
 *   answers with the first answer, never a second record (sandbox S6); when the attempts are spent,
 *   for QuickBooks' own 429 or 5xx or Intuit's 600, and for any refusal of a repeat — the attempt
 *   that went unanswered may have made the record (the kit's `writeQuickBooks`, Gate 25's
 *   AUT-38-1) — "QuickBooks did not confirm whether the … was created" — the safe side;
 * - every Intuit code the plan maps (6140, 6240, 610, 2500, 6190, 6200, 6210, 2050, 2290, 2300, 6430)
 *   in its own sentence, any other in the kit's, each saying the new vendor was added when this run
 *   added it;
 * - its line, which is also the run's summary, says what was recorded and the next step: "When this
 *   charge arrives in your bank feed, choose Match, not Add", or how the person who paid is repaid.
 */

const WHAT = 'Not recorded';

/** The vendor the record names: the plan's, or the one a planned new vendor became; null for none. */
function vendorIdOf(payee: Payee, newVendor: NewVendorState | null): string | null | undefined {
  switch (payee.kind) {
    case 'vendor':
      return payee.id;
    case 'new_vendor':
      return newVendor?.id;
    default:
      return null;
  }
}

const textOf = (value: unknown): string | null => cleanText(value);
const dayOf = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;

/** The record as QuickBooks answered it, the plan's values where QuickBooks says nothing. */
function createdFrom(plan: RecordPlan, id: string, record: JsonObject): CreatedState {
  const payee = isObject(record.VendorRef)
    ? record.VendorRef
    : isObject(record.EntityRef)
      ? record.EntityRef
      : undefined;
  const total = toCents(record.TotalAmt);
  return {
    record: plan.record,
    id,
    docNumber: textOf(record.DocNumber) ?? plan.docNumber,
    txnDate: dayOf(record.TxnDate) ?? plan.date,
    dueDate: plan.record === 'bill' ? (dayOf(record.DueDate) ?? plan.dueDate) : null,
    // A journal entry's TotalAmt is always 0 (Intuit's model): it says nothing of the amount.
    totalCents:
      plan.record === 'journal_entry' || total.kind !== 'cents' || total.cents < 0
        ? null
        : total.cents,
    payeeName: textOf(payee?.name),
  };
}

export function createRecord(): Step {
  return async ({ request, state, platform }) => {
    // A statement is compared, never recorded (D26).
    if (isStatementComparison(state)) return { outcome: 'skipped' };
    const added = vendorCreated(state);
    const saved = readSaved(state);
    const newVendor = newVendorOf(state);
    if (!saved || newVendor === undefined) {
      return failedWith(WHAT, 'state_incomplete', stateIncomplete('record', added));
    }
    const { plan } = saved;
    const vendorId = vendorIdOf(plan.payee, newVendor);
    const named = plan.operation === 'bill.create' || plan.operation === 'vendorCredit.create';
    // A new vendor neither found nor added — a first run, which a new vendor always holds — or a
    // bill or credit with no vendor: guards that should never fire.
    const noun = WRITE_NOUNS[plan.record];
    if (vendorId === undefined || (named && vendorId === null)) {
      return failedWith(WHAT, 'state_incomplete', stateIncomplete(noun, added));
    }
    let write: QuickBooksWrite;
    try {
      write = await writeQuickBooks({
        platform,
        kind: writeKindOf(plan),
        input: recordBody(plan, vendorId, request.runId),
      });
    } catch (error) {
      // On unchanged for the SDK's retry (S6); when its attempts are spent, the run's wrapper ends
      // with this sentence: the record may have been made.
      noteSentence(error, recordUnconfirmed(noun, added));
      throw error;
    }
    if (!write.ok) {
      const reason = write.detail === undefined ? write.reason : `${write.reason} ${write.detail}`;
      const kept =
        added && newVendor ? `; the new vendor stays (Id ${shorten(newVendor.id, 20)})` : '';
      return failedWith(`${WHAT}${kept}`, reason, recordFailure(write, noun, added));
    }
    const created = createdFrom(plan, write.id, write.record);
    return {
      outcome: 'ok',
      summary: recordedLine(saved, created, newVendor),
      state: { ...state, created: created as unknown as JsonObject },
    };
  };
}
