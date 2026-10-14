import type { Clock } from '@autom8x/automation-kit/quickbooks';
import type { JsonObject, Step } from '@autom8x/automation-sdk';

import type { LookupKey, LookupState, VendorState } from '../decide/contract.js';
import { lookupUses } from '../decide/lookup-uses.js';
import type { ExpenseSearch } from '../lookups/expense-search.js';
import { lookupLine, notCheckedLine } from '../lookups/lines.js';
import {
  amountSearch,
  numberSearch,
  otherRecordSearch,
  relatedSearch,
  type Search,
} from '../lookups/queries.js';
import { incomplete, lookupDocumentOf, lookupRows, lookupVendorOf } from '../lookups/read.js';
import { recordsOf } from '../lookups/records.js';
import { notRecorded } from '../quickbooks-path.js';
import type { DocumentState } from '../state.js';

/**
 * The record lookups — each its ONE query per document type, as the plan's §5 table runs it
 * (`src/lookups/queries.ts`), each gathering facts for decide and judging none, on the QuickBooks
 * path only; a read that fails is "not recorded in QuickBooks" (decision 6):
 *
 * - `find-duplicate-number`: a record that already carries the document's number — or, for a
 *   statement, this vendor's bills among the invoice numbers it lists;
 * - `find-duplicate-amount`: a record of the same amount — on a receipt and a card refund the
 *   bank-feed check (D21), on a statement this vendor's open bills;
 * - `find-related`: the record this one relates to — an expense with a bill's number (decision 6),
 *   a bill a receipt may pay (D22), a credit's original bill (D25);
 * - `find-other-record` (D32): the same purchase recorded as another kind of record.
 *
 * `lookupUses` — the table decide's contract reads too — says, per route, whether each runs: it
 * writes `{ reachedMax, records, answeredAt }` under its key; a lookup with no number QuickBooks
 * could hold says "Not checked" and writes nothing (G4-4); one that does not apply is skipped. A
 * full answer sets `reachedMax`, which decide counts as a possible duplicate (D6); `answeredAt`,
 * QuickBooks' own time on the answer, lets the re-check after an approval tell a record past that
 * bound from one added while the run waited (`src/decide/recheck.ts`).
 */

interface RecordLookup {
  readonly key: LookupKey;
  readonly purpose: string;
  readonly search: (
    document: DocumentState,
    vendor: VendorState | null,
    how: ExpenseSearch,
  ) => Search;
}

function recordLookup(lookup: RecordLookup, clock: Clock, how: ExpenseSearch): Step {
  return async (context) => {
    const document = lookupDocumentOf(context.state);
    const vendor = lookupVendorOf(context.state);
    // find-vendor wrote the vendor on every route.
    if (!document || !vendor) return incomplete();
    const use = lookupUses(document.route, document, vendor, how)[lookup.key];
    if (use === 'skip') return { outcome: 'skipped' };
    if (use === 'not_checked') {
      return { outcome: 'ok', summary: notCheckedLine(document, lookup.key) };
    }
    const search = lookup.search(document, vendor, how);
    const read = await lookupRows({
      context,
      clock,
      query: search.query,
      entity: search.entity,
      purpose: lookup.purpose,
    });
    if (!read.ok) return read.result;
    const records = recordsOf(search.entity, read.rows);
    if (!records) return notRecorded(context.state, 'no_answer');
    const found: LookupState = {
      reachedMax: read.rows.length >= search.maxResults,
      records,
      answeredAt: read.answeredAt,
    };
    return {
      outcome: 'ok',
      summary: lookupLine({ document, key: lookup.key, ...found }),
      state: { ...context.state, [lookup.key]: found as unknown as JsonObject },
    };
  };
}

export const findDuplicateNumber = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    { key: 'numberLookup', purpose: 'looking for records with this number', search: numberSearch },
    clock,
    how,
  );

export const findDuplicateAmount = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    { key: 'amountLookup', purpose: 'looking for records with this amount', search: amountSearch },
    clock,
    how,
  );

export const findRelated = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    { key: 'relatedLookup', purpose: 'looking for a related record', search: relatedSearch },
    clock,
    how,
  );

export const findOtherRecord = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    {
      key: 'otherRecordLookup',
      purpose: 'looking for the same purchase recorded another way',
      search: otherRecordSearch,
    },
    clock,
    how,
  );
