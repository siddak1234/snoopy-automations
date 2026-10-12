import { QUICKBOOKS_SENTENCES, type Clock } from '@autom8x/automation-kit/quickbooks';
import type { JsonObject, Step } from '@autom8x/automation-sdk';

import type { LookupKey, LookupState, VendorState } from '../decide/contract.js';
import { lookupUses } from '../decide/lookup-uses.js';
import type { ExpenseSearch } from '../lookups/expense-search.js';
import {
  amountLine,
  notCheckedLine,
  numberLine,
  otherRecordLine,
  relatedLine,
  type Found,
} from '../lookups/lines.js';
import {
  amountSearch,
  numberSearch,
  otherRecordSearch,
  relatedSearch,
  type Search,
} from '../lookups/queries.js';
import {
  lookupDocumentOf,
  lookupRows,
  lookupVendorOf,
  refused,
  type LookupSentence,
} from '../lookups/read.js';
import { recordsOf } from '../lookups/records.js';
import { failedWith } from '../outcome.js';
import type { DocumentState } from '../state.js';

/**
 * Steps 14–17, the record lookups — each its ONE query per document type, as the plan's §5 table
 * runs it (`src/lookups/queries.ts`), each gathering facts for decide and judging none:
 *
 * - `find-duplicate-number`: a record that already carries the document's number — or, for a
 *   statement, this vendor's bills among the invoice numbers it lists;
 * - `find-duplicate-amount`: a record of the same amount — on a receipt and a card refund the
 *   bank-feed check (D21), on a statement this vendor's open bills;
 * - `find-related`: the record this one relates to — an expense with a bill's number (decision 6),
 *   a bill a receipt may pay (D22), a credit's original bill (D25), a company charge for a purchase
 *   someone paid personally (hold 7);
 * - `find-other-record` (D32): the same purchase recorded as another kind of record.
 *
 * `lookupUses` — the table decide's contract reads too — says, per route, whether each runs: it
 * writes `{ reachedMax, records }` under its key; a lookup with no number QuickBooks could hold
 * says "Not checked" and writes nothing (G4-4); one that does not apply is skipped. A full answer
 * sets `reachedMax`, which decide counts as a possible duplicate (D6).
 */

interface RecordLookup {
  readonly key: LookupKey;
  /** The timeline's words when the step fails. */
  readonly what: string;
  readonly purpose: string;
  readonly refused: LookupSentence;
  /** A statement's, for the lookups one runs: it searches the vendor's bills, and is never entered. */
  readonly statementRefused?: LookupSentence;
  readonly search: (
    document: DocumentState,
    vendor: VendorState | null,
    how: ExpenseSearch,
  ) => Search;
  readonly line: (found: Found) => string;
}

function recordLookup(lookup: RecordLookup, clock: Clock, how: ExpenseSearch): Step {
  return async (context) => {
    const document = lookupDocumentOf(context.state);
    const vendor = lookupVendorOf(context.state);
    const personal = document?.route === 'employee' || document?.route === 'owner';
    // find-vendor wrote the vendor on every route but those two, which have none.
    if (!document || vendor === undefined || (vendor === null) !== personal) {
      return refused(lookup.what, 'state_incomplete');
    }
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
      what: lookup.what,
      purpose: lookup.purpose,
      refused:
        document.route === 'statement'
          ? (lookup.statementRefused ?? lookup.refused)
          : lookup.refused,
    });
    if (!read.ok) return read.result;
    const records = recordsOf(search.entity, read.rows);
    if (!records) {
      return failedWith(lookup.what, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer);
    }
    const found: LookupState = { reachedMax: read.rows.length >= search.maxResults, records };
    return {
      outcome: 'ok',
      summary: lookup.line({ document, vendor, how, rows: read.rows, ...found }),
      state: { ...context.state, [lookup.key]: found as unknown as JsonObject },
    };
  };
}

export const findDuplicateNumber = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    {
      key: 'numberLookup',
      what: 'Number not searched',
      purpose: 'looking for records with this number',
      refused: 'number_refused',
      statementRefused: 'statement_number_refused',
      search: numberSearch,
      line: numberLine,
    },
    clock,
    how,
  );

export const findDuplicateAmount = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    {
      key: 'amountLookup',
      what: 'Amount not searched',
      purpose: 'looking for records with this amount',
      refused: 'amount_refused',
      statementRefused: 'statement_amount_refused',
      search: amountSearch,
      line: amountLine,
    },
    clock,
    how,
  );

export const findRelated = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    {
      key: 'relatedLookup',
      what: 'Related record not searched',
      purpose: 'looking for a related record',
      refused: 'related_refused',
      search: relatedSearch,
      line: relatedLine,
    },
    clock,
    how,
  );

export const findOtherRecord = (clock: Clock, how: ExpenseSearch): Step =>
  recordLookup(
    {
      key: 'otherRecordLookup',
      what: 'Other records not searched',
      purpose: 'looking for the same purchase recorded another way',
      refused: 'other_record_refused',
      search: otherRecordSearch,
      line: otherRecordLine,
    },
    clock,
    how,
  );
