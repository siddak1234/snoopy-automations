import { isObject, type JsonObject, type Step, type StepResult } from '@autom8x/automation-sdk';

import { namedFields } from '../checks/fields.js';
import { decideRun } from '../decide/decide.js';
import type { ExpenseSearch } from '../lookups/expense-search.js';
import { runFails } from '../outcome.js';
import { NOT_RECORDED, QUICKBOOKS, quickBooksStateOf, vendorChoiceOf } from '../quickbooks-path.js';
import type { DocumentState, VerificationState } from '../state.js';
import { FINDING_WORDS, documentOf } from './check.js';
import { engineState, runStateOf, withEntries, type Entry, type RunState } from './state.js';
import { DOUBTS, countLine } from './words.js';

/**
 * `decide` (v3) — what becomes of each document, on its own (the session's spec, §3.2 step 12 and
 * B4; the owner's AM8): no QuickBooks or model call, so nothing to repeat.
 *
 * - A page that is clearly no financial document waits for review; any other financial document
 *   v2 had no record for — a quote, an order, a bank statement — is saved with all its data.
 * - A document whose first read the checks could not use, and the second could not settle, waits:
 *   "the total can't be read" (B4).
 * - With the vendor "None", a document waits when what made it doubtful is still so after the
 *   second read — totals that don't add up, unclear fields, a total not checked, two reads that
 *   differ or a second read not made (B4) — or when an earlier one in the file is the same
 *   purchase (B1); else it is saved.
 * - With QuickBooks: v2's decide on the document's own state (`src/decide/decide.ts`) — not
 *   recorded, compared, ready to record, or waiting with v2's hold phrases — and a document with a
 *   doubt found before decide waits too — the same purchase as an earlier one in the file, or the
 *   last read of a file counted to hold more — even one QuickBooks will not take, whose details
 *   are then saved after the approval; a statement compared never waits (v2).
 *
 * A waiting document keeps its plan for after the approval; one approval covers them all
 * (`ask-approval`). The chart and the raw reads leave the state here.
 */

/** Why a document still waits after its second read, with "None": v2's phrases (§2.6), in its order. */
export function readDoubts(document: DocumentState, verification: VerificationState): string[] {
  const findings = new Set(document.findings);
  const doubts: string[] = [];
  if (findings.has('amounts_mismatch')) doubts.push(FINDING_WORDS.amounts_mismatch(document));
  if (verification.status === 'made' && verification.differences.length > 0) {
    doubts.push(
      `two reads differ: ${namedFields(verification.differences.map((each) => each.field))}`,
    );
  }
  if (verification.status === 'not_made') doubts.push('second read not made');
  if (findings.has('unclear_fields')) doubts.push(FINDING_WORDS.unclear_fields(document));
  if (findings.has('not_cross_checked')) doubts.push(FINDING_WORDS.not_cross_checked(document));
  return doubts;
}

const waiting = (entry: Entry, reasons: readonly string[]): Entry => ({
  ...entry,
  stage: 'waiting',
  waitingFor: reasons.join(', '),
});
const settledAs = (entry: Entry, stage: 'ready' | 'done', engine = entry.engine): Entry => ({
  ...entry,
  stage,
  engine,
});

function verificationOf(engine: JsonObject): VerificationState {
  const value = engine.verification;
  return isObject(value) ? (value as unknown as VerificationState) : { status: 'not_needed' };
}

/** One document decided, or the run's end for a state no step should have left. */
function decided(
  entry: Entry,
  run: RunState,
  config: JsonObject,
  expenseSearch: ExpenseSearch,
): Entry | { readonly end: StepResult } {
  const { answer: _answer, ...rest } = entry;
  const base: Entry = rest;
  const doubts = [
    ...(entry.unsettled === undefined ? [] : [DOUBTS[entry.unsettled]]),
    ...entry.doubts,
  ];
  const document = documentOf(entry.engine);
  if (entry.kind === 'kept' || entry.kind === 'not_financial' || document === undefined) {
    return doubts.length > 0 ? waiting(base, doubts) : settledAs(base, 'done');
  }
  if (vendorChoiceOf(config) !== QUICKBOOKS) {
    const all = [...readDoubts(document, verificationOf(entry.engine)), ...doubts];
    return all.length > 0 ? waiting(base, all) : settledAs(base, 'done');
  }
  // A doubtful document waits even when QuickBooks will not take it: nothing is written either way.
  const savedUnless = (engine: JsonObject): Entry =>
    doubts.length > 0
      ? waiting(settledAs(base, 'done', engine), doubts)
      : settledAs(base, 'done', engine);
  // QuickBooks stopped for the whole run, or for this document: its details are saved.
  const stop = quickBooksStateOf(run) ?? quickBooksStateOf(entry.engine);
  if (stop) return savedUnless({ ...entry.engine, quickBooks: stop });
  const decision = decideRun({ state: engineState(run, entry), config, expenseSearch });
  switch (decision.outcome) {
    case 'failed':
      return { end: runFails('other', decision.failure) };
    case 'not_recorded':
      return savedUnless({
        ...entry.engine,
        quickBooks: { notRecorded: NOT_RECORDED[decision.reason] },
      });
    case 'compared':
      return settledAs(base, 'done', decision.result as unknown as JsonObject);
    case 'ok': {
      const saved = settledAs(base, 'ready', decision.saved as unknown as JsonObject);
      return doubts.length > 0 ? waiting(saved, doubts) : saved;
    }
    case 'held':
      return waiting(settledAs(base, 'ready', decision.saved as unknown as JsonObject), [
        ...decision.holds.map((hold) => hold.phrase),
        ...doubts,
      ]);
  }
}

/** The step's line: one document as v2 said it; several counted. */
function decideLine(entries: readonly Entry[]): string {
  const stoppedOf = (entry: Entry) => {
    const stop = quickBooksStateOf(entry.engine);
    return stop && 'notRecorded' in stop ? stop.notRecorded : null;
  };
  const compared = (entry: Entry) => entry.engine.route === 'statement';
  if (entries.length === 1) {
    const [entry] = entries as [Entry];
    if (entry.stage === 'ready') return 'Ready to record';
    if (entry.stage === 'waiting') return 'Waiting for approval';
    if (compared(entry)) return 'Compared with QuickBooks';
    const reason = stoppedOf(entry);
    return reason === null ? 'Ready to save' : `Not recorded in QuickBooks: ${reason}`;
  }
  const count = (test: (entry: Entry) => boolean) => entries.filter(test).length;
  return countLine([
    [count((entry) => entry.stage === 'ready'), 'ready to record'],
    [
      count((entry) => entry.stage === 'done' && !compared(entry) && stoppedOf(entry) === null),
      'to save',
    ],
    [count((entry) => entry.stage === 'waiting'), 'waiting for approval'],
    [count(compared), 'compared'],
    [count((entry) => stoppedOf(entry) !== null), 'not recorded'],
  ]);
}

export function decide(expenseSearch: ExpenseSearch): Step {
  return ({ request, state }) => {
    const run = runStateOf(state);
    if (!run) return Promise.resolve(runFails('other', 'state_incomplete'));
    const entries: Entry[] = [];
    for (const entry of run.documents) {
      if (entry.stage !== 'read') {
        entries.push(entry);
        continue;
      }
      const next = decided(entry, run, request.config, expenseSearch);
      if ('end' in next) return Promise.resolve(next.end);
      entries.push(next);
    }
    // The chart has done its work, and leaves the state (v2's decide).
    const { chart: _chart, ...rest } = state;
    return Promise.resolve({
      outcome: 'ok',
      summary: decideLine(entries),
      state: withEntries(rest, entries),
    });
  };
}
