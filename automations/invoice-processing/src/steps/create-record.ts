import { writeQuickBooks } from '@autom8x/automation-kit/quickbooks';
import { cleanText, toCents } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import type { Payee, RecordPlan } from '../decide/plan.js';
import { runFails } from '../outcome.js';
import { writeFailed } from '../quickbooks-path.js';
import { recordBody, writeKindOf } from '../writes/bodies.js';
import { recordedLine } from '../writes/lines.js';
import {
  isStatementComparison,
  newVendorOf,
  readSaved,
  type CreatedState,
  type NewVendorState,
} from '../writes/saved-state.js';

/**
 * `create-record` — the ONE write: the record decide planned, exactly as saved — straight after
 * decide in a run that did not hold, or after confirm-no-duplicate once an approval resumed it — and
 * nothing for a statement (the plan's §2.6, §2.8, §5 "Writes"):
 *
 * - a bill (`bill.create`), an expense or a card refund (`purchase.create`), or a vendor credit
 *   (`vendorCredit.create`), its body built from the saved plan alone (`src/writes/bodies.ts`); the
 *   memo names this run, after an approval the continuation;
 * - one request, repeated only by the SDK's step retry when nothing answered — no answer, a
 *   502/503/504 naming no reason — under the same key, so the same `requestid`, which Intuit
 *   answers with the first answer, never a second record (sandbox S6);
 * - a write QuickBooks may have made — its own 429 or 5xx, Intuit's 600, any refusal of a repeat
 *   after an attempt nothing answered (the kit's `writeQuickBooks`, Gate 25's AUT-38-1), or the
 *   retry's attempts spent (the run's `recover`) — is "QuickBooks didn't confirm", the safe side: the
 *   details are saved and the result says to check QuickBooks before running it again; a certain
 *   refusal is "not recorded in QuickBooks" (decision 6).
 *
 * Line (§3.E): `Recorded: bill HOS-1042, $461.53`.
 */

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
    totalCents: total.kind !== 'cents' || total.cents < 0 ? null : total.cents,
    payeeName: textOf(payee?.name),
  };
}

export function createRecord(): Step {
  return async ({ request, state, platform }) => {
    // A statement is compared, never recorded (D26).
    if (isStatementComparison(state)) return { outcome: 'skipped' };
    const saved = readSaved(state);
    const newVendor = newVendorOf(state);
    if (!saved || newVendor === undefined) return runFails('other', 'state_incomplete');
    const { plan } = saved;
    const vendorId = vendorIdOf(plan.payee, newVendor);
    const named = plan.operation === 'bill.create' || plan.operation === 'vendorCredit.create';
    // A new vendor neither found nor added — a first run, which a new vendor always holds — or a
    // bill or credit with no vendor: guards that should never fire.
    if (vendorId === undefined || (named && vendorId === null)) {
      return runFails('other', 'state_incomplete');
    }
    const write = await writeQuickBooks({
      platform,
      kind: writeKindOf(plan),
      input: recordBody(plan, vendorId, request.runId),
    });
    if (!write.ok) return writeFailed(state, write);
    const created = createdFrom(plan, write.id, write.record);
    return {
      outcome: 'ok',
      summary: recordedLine(saved, created),
      state: { ...state, created: created as unknown as JsonObject },
    };
  };
}
