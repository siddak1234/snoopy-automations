import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { capitalised, sameName, utcDay } from '@autom8x/automation-kit/values';
import {
  isObject,
  truncateText,
  type JsonObject,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { checkFirstRead } from '../checks/check.js';
import { namedFields } from '../checks/fields.js';
import { RECORDING_RULES } from '../checks/rules.js';
import { runFails } from '../outcome.js';
import { NOT_RECORDED, QUICKBOOKS, vendorChoiceOf } from '../quickbooks-path.js';
import type { DocumentState, Finding } from '../state.js';
import { LINE_MAXIMUM } from '../words.js';
import { runStateOf, withEntries, type Entry } from './state.js';
import { DOUBTS, countLine, sameAs } from './words.js';

/**
 * `check-documents` (code only) — each document's first read cleaned once, routed and held to v2's
 * rules (`src/checks/check.ts`), on its own: one document never fails another, and none fails the
 * run (B4). A bill, an invoice, a receipt or a credit note and a statement are checked; what the
 * rules say the document cannot be used under is left `unsettled` for the second read to settle
 * (B4: the seller, the total or the date unreadable, the date not real, pages missing, a statement
 * with nothing to read). Any other financial document is kept as read (AM8); a page that is
 * clearly no financial document waits for review. Two documents in one file with the same seller,
 * date and total: the second waits, "same as document 1" (B1).
 *
 * On the QuickBooks path, a rule QuickBooks cannot record a document under keeps that one
 * document out of QuickBooks — "not recorded in QuickBooks" — its details saved (v2's S2); the
 * company's own name (C10) is weighed once the company is read (`quickbooks.ts`).
 */

/** What check-document found, as its line and decide's hold phrases say it (v2's §2.6). */
export const FINDING_WORDS: Readonly<Record<Finding, (document: DocumentState) => string>> = {
  lists_other_invoices: () => 'may be a statement',
  earlier_balance: () => 'earlier balance also due',
  refund_method_not_shown: () => 'refund method not shown',
  tip_added: () => 'tip added to the total',
  amounts_mismatch: () => "totals don't add up",
  unclear_fields: (document) => `unclear: ${namedFields(document.unclearFields)}`,
  not_cross_checked: () => 'total not checked',
  currency_unrecognised: () => 'currency not recognised',
};

/** v2's line for one document (§3.E): `Checks passed`, or what was found, joined by commas. */
export function checkedSummary(document: DocumentState): string {
  if (document.findings.length === 0) return 'Checks passed';
  const found = document.findings.map((finding) => FINDING_WORDS[finding](document));
  return truncateText(capitalised(found.join(', ')), LINE_MAXIMUM);
}

/** check-document's document in an entry's state, when its first read could be used. */
export function documentOf(engine: JsonObject): DocumentState | undefined {
  const { document } = engine;
  return isObject(document) &&
    typeof document.route === 'string' &&
    typeof document.seller === 'string' &&
    isObject(document.arithmetic)
    ? (document as unknown as DocumentState)
    : undefined;
}

/** One document checked: kept as read, waiting for review, unsettled, or its clean values. */
export function checkedEntry(entry: Entry, quickBooks: boolean, today: string): Entry {
  if (entry.kind === 'not_financial') return { ...entry, doubts: [DOUBTS.not_financial] };
  if (entry.kind === 'kept' || entry.answer === undefined) return entry;
  const outcome = checkFirstRead({
    answer: entry.answer,
    quickBooks,
    companyName: null,
    legalName: null,
    today,
  });
  if (outcome.outcome === 'failed') return { ...entry, unsettled: outcome.rule, engine: {} };
  const { unsettled: _settled, ...rest } = entry;
  const rule = outcome.recordingRule;
  return {
    ...rest,
    engine: {
      document: outcome.document as unknown as JsonObject,
      ...(rule === undefined
        ? {}
        : { quickBooks: { notRecorded: NOT_RECORDED[RECORDING_RULES[rule]] } }),
    },
  };
}

/** A record's seller, date and total, to tell two copies of one purchase in one file. */
function purchaseOf(entry: Entry): DocumentState | undefined {
  if (entry.kind !== 'record') return undefined;
  const document = documentOf(entry.engine);
  return document !== undefined && document.date !== null && document.totalCents !== null
    ? document
    : undefined;
}

/** The documents, each later copy of an earlier one in the file waiting: "same as document 1". */
export function withSameFileDoubts(entries: readonly Entry[]): Entry[] {
  return entries.map((entry, at) => {
    const purchase = purchaseOf(entry);
    if (!purchase) return entry;
    const earlier = entries.slice(0, at).find((other) => {
      const before = purchaseOf(other);
      return (
        before !== undefined &&
        sameName(before.seller, purchase.seller) &&
        before.date === purchase.date &&
        before.totalCents === purchase.totalCents
      );
    });
    return earlier === undefined
      ? entry
      : { ...entry, doubts: [...entry.doubts, sameAs(earlier.index)] };
  });
}

/** The step's line: one document as v2 said it; several counted. */
function checkLine(entries: readonly Entry[]): string {
  if (entries.length === 1) {
    const [entry] = entries as [Entry];
    if (entry.unsettled !== undefined) return capitalised(DOUBTS[entry.unsettled]);
    if (entry.doubts.length > 0) return capitalised(entry.doubts.join(', '));
    const stop = entry.engine.quickBooks;
    if (isObject(stop) && typeof stop.notRecorded === 'string') {
      return truncateText(`Not recorded in QuickBooks: ${stop.notRecorded}`, LINE_MAXIMUM);
    }
    const document = documentOf(entry.engine);
    return document ? checkedSummary(document) : 'No checks needed';
  }
  const unclear = entries.filter(
    (entry) => entry.unsettled !== undefined || entry.doubts.length > 0,
  ).length;
  return countLine([
    [entries.length, 'documents checked'],
    [unclear, 'unclear'],
  ]);
}

export function checkDocuments(clock: Pick<Clock, 'now'>): Step {
  return ({ request, state }): Promise<StepResult> => {
    const run = runStateOf(state);
    if (!run) return Promise.resolve(runFails('other', 'state_incomplete'));
    const quickBooks = vendorChoiceOf(request.config) === QUICKBOOKS;
    const today = utcDay(clock.now());
    const entries = withSameFileDoubts(
      run.documents.map((entry) => checkedEntry(entry, quickBooks, today)),
    );
    return Promise.resolve({
      outcome: 'ok',
      summary: checkLine(entries),
      state: withEntries(state, entries),
    });
  };
}
