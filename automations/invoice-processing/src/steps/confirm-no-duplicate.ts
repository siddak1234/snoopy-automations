import {
  queryRowsOf,
  readQuickBooks,
  type Clock,
  type QuickBooksRead,
} from '@autom8x/automation-kit/quickbooks';
import { shorten } from '@autom8x/automation-kit/values';
import type { Step } from '@autom8x/automation-sdk';

import type { FoundRecord } from '../decide/contract.js';
import { isDuplicate } from '../decide/duplicate-rule.js';
import type { SavedState } from '../decide/saved.js';
import { noteSentence } from '../failures.js';
import { recordsOf } from '../lookups/records.js';
import { failedWith } from '../outcome.js';
import { NOUNS } from '../writes/lines.js';
import { readSaved, vendorCreated } from '../writes/saved-state.js';
import {
  duplicateAppeared,
  recheckFailure,
  recheckUnreachable,
  stateIncomplete,
} from '../writes/sentences.js';

/**
 * `confirm-no-duplicate` (step 22) — after an approval, right before the record is written, the
 * path's own duplicate lookup once more (the plan's §5; `src/decide/recheck.ts`): decide saved the
 * very query its lookup step sent, one row more, and the facts the ONE rule compares
 * (`src/decide/duplicate-rule.ts`), so this step and decide cannot disagree. Every record the
 * approver already saw — any lookup's, by kind — is allowed; a record the rule matches that was
 * not there then fails: "A matching record was added in QuickBooks while this waited for
 * approval, possibly from your bank feed." A full answer with nothing new goes on, its line saying
 * more may exist — as decide's "too many to check" told the approver. A first run skips: its
 * lookups ran moments earlier.
 *
 * It runs after create-vendor, as approved, so once this run added the vendor every sentence here
 * says so — a thrown one too, registered on the error for the run's wrapper (`noteSentence`).
 */

const WHAT = 'Duplicate not checked again';

/** Whether the approver saw this record: any lookup decide's run made returned it. */
function seen(saved: SavedState, record: FoundRecord): boolean {
  const { duplicates } = saved;
  const ids = {
    bill: duplicates.billIds,
    expense: duplicates.expenseIds,
    vendor_credit: duplicates.vendorCreditIds,
    journal_entry: duplicates.journalEntryIds,
  }[record.kind];
  return ids.includes(record.id);
}

export function confirmNoDuplicate(clock: Clock): Step {
  return async ({ request, state, platform }) => {
    if (!request.continuation) return { outcome: 'skipped' };
    const added = vendorCreated(state);
    const saved = readSaved(state);
    if (!saved) {
      return failedWith(WHAT, 'state_incomplete', stateIncomplete('record', added));
    }
    const noun = NOUNS[saved.plan.record];
    const { recheck } = saved;
    let read: QuickBooksRead;
    try {
      read = await readQuickBooks({
        platform,
        deadline: request.deadline,
        clock,
        operation: 'query.run',
        input: { query: recheck.query },
        purpose: 'checking for a matching record added while this waited',
      });
    } catch (error) {
      // Thrown on unchanged for the SDK's retry; when its attempts are spent, the run's wrapper
      // ends with this sentence, which says the vendor was added when it was.
      if (added) noteSentence(error, recheckUnreachable(noun, true));
      throw error;
    }
    if (!read.ok) {
      const reason = read.detail === undefined ? read.reason : `${read.reason} ${read.detail}`;
      return failedWith(WHAT, reason, recheckFailure(read.reason, noun, added));
    }
    const rows = queryRowsOf(read.body, recheck.entity);
    const records = rows === undefined ? undefined : recordsOf(recheck.entity, rows);
    if (rows === undefined || records === undefined) {
      return failedWith(
        WHAT,
        'unexpected_answer',
        recheckFailure('unexpected_answer', noun, added),
      );
    }
    const fresh = records.filter(
      (record) => !seen(saved, record) && isDuplicate(recheck.facts, recheck.lookup, record),
    );
    if (fresh.length > 0) {
      const ids = fresh.slice(0, 5).map((record) => shorten(record.id, 20));
      const more = fresh.length > 5 ? ` +${fresh.length - 5} more` : '';
      return failedWith(
        `A matching record was added while this waited: Id ${ids.join(', ')}${more}`,
        'duplicate_appeared',
        duplicateAppeared(noun, added),
      );
    }
    const shown = records.filter((record) => seen(saved, record)).length;
    const full = rows.length >= recheck.maxResults;
    return {
      outcome: 'ok',
      summary: [
        'No matching record added since this was held',
        ...(shown > 0 ? [`${shown} already shown to the approver`] : []),
        ...(full ? ['the search was full, so more may exist'] : []),
      ].join('; '),
    };
  };
}
