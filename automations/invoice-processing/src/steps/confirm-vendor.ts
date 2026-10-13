import {
  QUICKBOOKS_SENTENCES,
  rowsNaming,
  writeQuickBooks,
  type Clock,
  type QuickBooksWrite,
} from '@autom8x/automation-kit/quickbooks';
import {
  MAXIMUM_NAME_LENGTH,
  cleanText,
  fitLine,
  sameName,
  shorten,
} from '@autom8x/automation-kit/values';
import type { JsonObject, Step, StepResult } from '@autom8x/automation-sdk';

import { DECIDE_SENTENCES } from '../decide/fails.js';
import type { Payee } from '../decide/plan.js';
import type { SavedState } from '../decide/saved.js';
import { noteSentence } from '../failures.js';
import { vendorByName } from '../lookups/queries.js';
import { LOOKUP_SENTENCES, lookupRows } from '../lookups/read.js';
import { matchedVendorOf } from '../lookups/records.js';
import { failedWith } from '../outcome.js';
import { vendorBody } from '../writes/bodies.js';
import { newVendorOf, readSaved, type NewVendorState } from '../writes/saved-state.js';
import { AFTER_APPROVAL_SENTENCES, vendorFailure } from '../writes/sentences.js';

/**
 * Steps 20 and 21, for a bill whose vendor was new when it was held — only in an approval's
 * continuation, as a new vendor always holds (ip-review design-after-approval-writes-notify-
 * tests.json steps[1]–[2]):
 *
 * - `confirm-vendor` looks the vendor up again by the name it would be created with — the printed
 *   name, or "<name> (vendor)" when a customer or an employee has it — in case someone added it
 *   while the run waited: found, active and in USD, the bill is linked to it and nothing is
 *   created; inactive, or two, fails as find-vendor does. The display name only: a company-name
 *   re-check would be a 25th step (the design's open question, its recommended answer applied).
 * - `create-vendor` then adds it, when it is still missing, exactly as the approver saw it named
 *   (`vendorBody`). One write, repeated only by the SDK's step retry when nothing answered — no
 *   answer, a 502/503/504 naming no reason — under the same key, so the same `requestid`, which
 *   Intuit answers with the first answer, never a second vendor (sandbox S6); when the attempts
 *   are spent, for QuickBooks' own 429 or 5xx, and for any refusal of a repeat after an attempt
 *   that went unanswered (the kit's `writeQuickBooks`, Gate 25's AUT-38-1), the run ends "did not
 *   confirm", the safe side.
 *   It runs before confirm-no-duplicate, as approved: if a later step fails, the vendor stays — a
 *   real supplier, which the next document matches — and that step's sentence says it was added
 *   (the recommended answer to keeping that order).
 */

const LOOK_WHAT = 'New vendor not looked up again';
const ADD_WHAT = 'New vendor not added';

type NewVendor = Extract<Payee, { kind: 'new_vendor' }>;

/** The saved data and the new vendor its plan names; 'skipped' for any other payee; the state's guard. */
function plannedVendor(
  state: JsonObject,
  what: string,
): { readonly saved: SavedState; readonly payee: NewVendor } | 'skipped' | StepResult {
  const saved = readSaved(state);
  if (!saved) {
    return failedWith(what, 'state_incomplete', AFTER_APPROVAL_SENTENCES.state_incomplete);
  }
  const { payee } = saved.plan;
  return payee.kind === 'new_vendor' ? { saved, payee } : 'skipped';
}

const nearMisses = (ignored: number) =>
  ignored === 0 ? '' : `; ${ignored} near-miss${ignored === 1 ? '' : 'es'} ignored`;

export function confirmVendor(clock: Clock): Step {
  return async (context) => {
    if (!context.request.continuation) return { outcome: 'skipped' };
    const planned = plannedVendor(context.state, LOOK_WHAT);
    if (planned === 'skipped') return { outcome: 'skipped' };
    if ('outcome' in planned) return planned;
    const { saved, payee } = planned;
    const read = await lookupRows({
      context,
      clock,
      query: vendorByName(payee.name),
      entity: 'Vendor',
      what: LOOK_WHAT,
      purpose: 'looking up the new vendor again',
      refused: 'vendor_refused',
    });
    if (!read.ok) return read.result;
    // As find-vendor reads it: the name, else an inactive vendor renamed from it, capital letters
    // aside; a row QuickBooks matched otherwise is a near-miss, ignored.
    const named = rowsNaming(read.rows, 'DisplayName', payee.name, sameName);
    const kept = named.rows;
    const ignored = nearMisses(named.others);
    if (kept.length === 0) {
      return {
        outcome: 'ok',
        summary: fitLine([
          "Vendor '",
          { name: payee.name },
          `' is still not in QuickBooks; it will be added${ignored}`,
        ]),
      };
    }
    if (kept.length > 1) {
      return failedWith(LOOK_WHAT, 'vendor_ambiguous', LOOKUP_SENTENCES.vendor_ambiguous);
    }
    const [row] = kept as [JsonObject];
    // A missing Active is Intuit's default, true.
    if (row.Active === false) {
      return failedWith(LOOK_WHAT, 'vendor_inactive', LOOKUP_SENTENCES.vendor_inactive);
    }
    const vendor = matchedVendorOf(row, 'display name', payee.name);
    if (!vendor) {
      return failedWith(LOOK_WHAT, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    // decide's F2: a vendor's currency, none set the home currency, must be USD.
    if ((vendor.currency ?? saved.preferences.homeCurrency) !== 'USD') {
      return failedWith(LOOK_WHAT, 'vendor_currency_not_usd', DECIDE_SENTENCES.F2);
    }
    const found: NewVendorState = { how: 'found', id: vendor.id, displayName: vendor.displayName };
    return {
      outcome: 'ok',
      summary: fitLine([
        "Vendor '",
        { name: vendor.displayName },
        `' was added to QuickBooks while this waited (Id ${shorten(vendor.id, 20)}); the bill will use it${ignored}`,
      ]),
      state: { ...context.state, newVendor: found as unknown as JsonObject },
    };
  };
}

export function createVendor(): Step {
  return async ({ request, state, platform }) => {
    if (!request.continuation) return { outcome: 'skipped' };
    const planned = plannedVendor(state, ADD_WHAT);
    if (planned === 'skipped') return { outcome: 'skipped' };
    if ('outcome' in planned) return planned;
    const { payee } = planned;
    const already = newVendorOf(state);
    if (already === undefined) {
      return failedWith(ADD_WHAT, 'state_incomplete', AFTER_APPROVAL_SENTENCES.state_incomplete);
    }
    // Found while the run waited: linked, not created.
    if (already !== null) return { outcome: 'skipped' };
    // decide failed a longer name (F4); a guard that should never fire.
    if (payee.name.length > MAXIMUM_NAME_LENGTH) {
      return failedWith(ADD_WHAT, 'state_incomplete', AFTER_APPROVAL_SENTENCES.state_incomplete);
    }
    let write: QuickBooksWrite;
    try {
      write = await writeQuickBooks({ platform, kind: 'vendor', input: vendorBody(payee) });
    } catch (error) {
      // On unchanged for the SDK's retry (S6); when its attempts are spent, the run's wrapper ends
      // with this sentence: the vendor may have been added.
      noteSentence(error, AFTER_APPROVAL_SENTENCES.vendor_unconfirmed);
      throw error;
    }
    if (!write.ok) {
      const reason = write.detail === undefined ? write.reason : `${write.reason} ${write.detail}`;
      return failedWith(ADD_WHAT, reason, vendorFailure(write));
    }
    const displayName = cleanText(write.record.DisplayName) ?? payee.name;
    const created: NewVendorState = { how: 'created', id: write.id, displayName };
    const why =
      payee.nameInUseBy === null
        ? ''
        : `; named with (vendor) because a ${payee.nameInUseBy} has that name`;
    return {
      outcome: 'ok',
      summary: fitLine([
        "Added vendor '",
        { name: displayName },
        `' to QuickBooks (Id ${shorten(write.id, 20)})${why}`,
      ]),
      state: { ...state, newVendor: created as unknown as JsonObject },
    };
  };
}
