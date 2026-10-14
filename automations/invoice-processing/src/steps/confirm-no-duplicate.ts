import { queryRowsOf, readQuickBooks, type Clock } from '@autom8x/automation-kit/quickbooks';
import type { Step } from '@autom8x/automation-sdk';

import type { FoundRecord } from '../decide/contract.js';
import { isDuplicate } from '../decide/duplicate-rule.js';
import { createdBefore } from '../decide/recheck.js';
import type { SavedState } from '../decide/saved.js';
import { recordsOf } from '../lookups/records.js';
import { runFails } from '../outcome.js';
import { notRecorded, readFailed } from '../quickbooks-path.js';
import { readSaved } from '../writes/saved-state.js';

/**
 * `confirm-no-duplicate` — after an approval, right before the record is written, the
 * path's own duplicate lookup once more (the plan's §5; `src/decide/recheck.ts`): decide saved the
 * very query its lookup step sent, one row more and the newest created first — so a record made
 * while the run waited is within the bound however many older ones match (sandbox G4–5) — and the
 * facts the ONE rule compares (`src/decide/duplicate-rule.ts`), so this step and decide cannot
 * disagree. Every record the
 * approver already saw — any lookup's, by kind — is allowed; a record the rule matches that was
 * not there then keeps this one out of QuickBooks: "Not recorded in QuickBooks: may already be in
 * QuickBooks", the details saved (decision 6). When decide's lookup was full, the approver approved
 * "too many to check": a match QuickBooks created before that answer was already there, past the
 * lookup's bound, and is allowed too. What is new is judged by QuickBooks' own clock, not by the
 * approver never having seen it: past a full lookup's bound some match is always unseen, so four
 * identical charges on a card would otherwise stop every approval. A first run skips: its lookups
 * ran moments earlier. Line (§3.E): `No duplicate`.
 */

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
    const saved = readSaved(state);
    if (!saved) return runFails('other', 'state_incomplete');
    const { recheck } = saved;
    // Thrown on unchanged for the SDK's retry; when its attempts are spent, the run's `recover`.
    const read = await readQuickBooks({
      platform,
      deadline: request.deadline,
      clock,
      operation: 'query.run',
      input: { query: recheck.query },
      purpose: 'checking for a matching record added while this waited',
    });
    if (!read.ok) return readFailed(state, read);
    const rows = queryRowsOf(read.body, recheck.entity);
    const records = rows === undefined ? undefined : recordsOf(recheck.entity, rows);
    if (rows === undefined || records === undefined) return notRecorded(state, 'no_answer');
    // The matches the approver did not see: added while this waited, unless decide's full lookup
    // left them past its bound — QuickBooks created them before it answered.
    const fresh = records.filter(
      (record, index) =>
        !seen(saved, record) &&
        isDuplicate(recheck.facts, recheck.lookup, record) &&
        !createdBefore(rows[index], recheck.fullAt),
    );
    if (fresh.length > 0) return notRecorded(state, 'may_already_be_recorded');
    return { outcome: 'ok', summary: 'No duplicate' };
  };
}
