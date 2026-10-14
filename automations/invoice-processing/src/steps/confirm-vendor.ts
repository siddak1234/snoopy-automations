import { rowsNaming, writeQuickBooks, type Clock } from '@autom8x/automation-kit/quickbooks';
import { MAXIMUM_NAME_LENGTH, cleanText, sameName } from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepResult } from '@autom8x/automation-sdk';

import type { Payee } from '../decide/plan.js';
import type { SavedState } from '../decide/saved.js';
import { vendorByName } from '../lookups/queries.js';
import { lookupRows } from '../lookups/read.js';
import { matchedVendorOf } from '../lookups/records.js';
import { runFails } from '../outcome.js';
import { notRecorded, writeFailed } from '../quickbooks-path.js';
import { vendorBody } from '../writes/bodies.js';
import { newVendorOf, readSaved, type NewVendorState } from '../writes/saved-state.js';

/**
 * Two steps for a bill whose vendor was new when it was held — only in an approval's continuation,
 * as a new vendor always holds (ip-review design-after-approval-writes-notify-tests.json
 * steps[1]–[2]); what keeps the bill out of QuickBooks after all is "not recorded in QuickBooks", and
 * the details are saved (decision 6). Lines (§3.E): `New vendor`, `Vendor found`, `Vendor added`.
 *
 * - `confirm-vendor` looks the vendor up again by the name it would be created with — the printed
 *   name, or "<name> (vendor)" when a customer or an employee has it — in case someone added it
 *   while the run waited: found, active and in USD, the bill is linked to it and nothing is
 *   created; inactive, or two, is not recorded, as find-vendor has it. The display name only: a
 *   company-name
 *   re-check would be a 25th step (the design's open question, its recommended answer applied).
 * - `create-vendor` then adds it, when it is still missing, exactly as the approver saw it named
 *   (`vendorBody`). One write, repeated only by the SDK's step retry when nothing answered — no
 *   answer, a 502/503/504 naming no reason — under the same key, so the same `requestid`, which
 *   Intuit answers with the first answer, never a second vendor (sandbox S6); when the attempts
 *   are spent, for QuickBooks' own 429 or 5xx, and for any refusal of a repeat after an attempt
 *   that went unanswered (the kit's `writeQuickBooks`, Gate 25's AUT-38-1), QuickBooks "didn't
 *   confirm", the safe side. It runs before confirm-no-duplicate, as approved: if a later step
 *   stops the bill, the vendor stays — a real supplier, which the next document matches.
 */

type NewVendor = Extract<Payee, { kind: 'new_vendor' }>;

/** The saved data and the new vendor its plan names; 'skipped' for any other payee; the state's guard. */
function plannedVendor(
  state: JsonObject,
): { readonly saved: SavedState; readonly payee: NewVendor } | 'skipped' | StepResult {
  const saved = readSaved(state);
  if (!saved) return runFails('other', 'state_incomplete');
  const { payee } = saved.plan;
  return payee.kind === 'new_vendor' ? { saved, payee } : 'skipped';
}

export function confirmVendor(clock: Clock): Step {
  return async (context) => {
    if (!context.request.continuation) return { outcome: 'skipped' };
    const planned = plannedVendor(context.state);
    if (planned === 'skipped') return { outcome: 'skipped' };
    if ('outcome' in planned) return planned;
    const { saved, payee } = planned;
    const { state } = context;
    const read = await lookupRows({
      context,
      clock,
      query: vendorByName(payee.name),
      entity: 'Vendor',
      purpose: 'looking up the new vendor again',
    });
    if (!read.ok) return read.result;
    // As find-vendor reads it: the name, else an inactive vendor renamed from it, capital letters
    // aside; a row QuickBooks matched otherwise is a near-miss, ignored.
    const kept = rowsNaming(read.rows, 'DisplayName', payee.name, sameName).rows;
    if (kept.length === 0) return { outcome: 'ok', summary: 'New vendor' };
    // Two with the name, or an inactive one: no active vendor is that one.
    const [row] = kept as [JsonObject];
    if (kept.length > 1 || row.Active === false) {
      return notRecorded(state, 'vendor_not_in_quickbooks');
    }
    const vendor = matchedVendorOf(row, 'display name', payee.name);
    if (!vendor) return notRecorded(state, 'no_answer');
    // decide's F2: a vendor's currency, none set the home currency, must be USD.
    if ((vendor.currency ?? saved.preferences.homeCurrency) !== 'USD') {
      return notRecorded(state, 'vendor_currency');
    }
    const found: NewVendorState = { how: 'found', id: vendor.id, displayName: vendor.displayName };
    return {
      outcome: 'ok',
      summary: 'Vendor found',
      state: { ...state, newVendor: found as unknown as JsonObject },
    };
  };
}

export function createVendor(): Step {
  return async ({ request, state, platform }) => {
    if (!request.continuation) return { outcome: 'skipped' };
    const planned = plannedVendor(state);
    if (planned === 'skipped') return { outcome: 'skipped' };
    if ('outcome' in planned) return planned;
    const { payee } = planned;
    const already = newVendorOf(state);
    if (already === undefined) return runFails('other', 'state_incomplete');
    // Found while the run waited: linked, not created.
    if (already !== null) return { outcome: 'skipped' };
    // decide kept a longer name out of QuickBooks (F4); a guard that should never fire.
    if (payee.name.length > MAXIMUM_NAME_LENGTH) return runFails('other', 'state_incomplete');
    // One write. Thrown on unchanged for the SDK's retry (S6); when its attempts are spent, the run's
    // `recover` says QuickBooks did not confirm it — the vendor may have been added.
    const write = await writeQuickBooks({ platform, kind: 'vendor', input: vendorBody(payee) });
    if (!write.ok) {
      // A certain refusal of a name too long for QuickBooks (Intuit's 2050) says so.
      return write.created === false && write.reason === 'qb_refused' && write.detail === '2050'
        ? notRecorded(state, 'vendor_name_too_long')
        : writeFailed(state, write);
    }
    const displayName = cleanText(write.record.DisplayName) ?? payee.name;
    const created: NewVendorState = { how: 'created', id: write.id, displayName };
    return {
      outcome: 'ok',
      summary: 'Vendor added',
      state: { ...state, newVendor: created as unknown as JsonObject },
    };
  };
}
