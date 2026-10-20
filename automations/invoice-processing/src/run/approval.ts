import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { held, type JsonObject, type Step, type StepContext } from '@autom8x/automation-sdk';

import { runFails } from '../outcome.js';
import { NOT_RECORDED, QUICKBOOKS, notRecordedLine, vendorChoiceOf } from '../quickbooks-path.js';
import { confirmCompany } from '../steps/confirm-company.js';
import { readSaved } from '../writes/saved-state.js';
import { lineWith } from '../words.js';
import { outcomeOf, runDocumentsOf, summarised } from './documents.js';
import { stopped } from './fan-out.js';
import { planned, quickBooksRun } from './quickbooks.js';
import { artifactIdOf, runStateOf, withEntries, type Entry } from './state.js';
import { DOUBTS, approvalReason, countLine } from './words.js';

/**
 * The end of the first run and the start of an approval's continuation (the session's spec, §3.2
 * steps 15–17 and 22; B4): the documents saved; ONE approval for every document that waits, the
 * others recorded or saved before it; and, after the approval, the company checked again once for
 * every document that waited for QuickBooks, and those QuickBooks will not take saved.
 */

const SAVED = new Set(['saved', 'not_recorded', 'unconfirmed']);

/** The saved documents' line: one as v2 said it — `Saved: Lowe's, $17.19` — several counted. */
function savedLine(entries: readonly Entry[], context: StepContext): string {
  if (entries.length !== 1) return countLine([[entries.length, 'saved']]);
  const [entry] = entries as [Entry];
  const { seller, total } = summarised(entry, context.request);
  return lineWith('Saved: ', seller ?? 'document', total === null ? '' : `, ${total}`);
}

/**
 * `save-documents` — the first run's documents saved: those with "None", those QuickBooks has no
 * record for, and those it did not take. Code only: the run's result carries their details.
 */
export const saveDocuments: Step = async (context) => {
  const run = runStateOf(context.state);
  if (!run) return runFails('other', 'state_incomplete');
  // A document left ready — its record not written — is saved with the rest.
  const entries = run.documents.map((entry): Entry =>
    entry.stage === 'ready' ? { ...entry, stage: 'done' } : entry,
  );
  const saved = entries.filter(
    (entry) => entry.stage === 'done' && SAVED.has(outcomeOf(entry, context.request).status),
  );
  if (saved.length === 0) return { outcome: 'skipped' };
  return {
    outcome: 'ok',
    summary: savedLine(saved, context),
    state: withEntries(context.state, entries),
  };
};

/**
 * `ask-approval` — the run holds ONCE for every document that waits (B4): the approval's reason
 * names each, "Document 2: the total can't be read.", and the held result carries every document,
 * those recorded and saved before it included. Approved, the continuation goes on after this step
 * with the state as it was; rejected, nothing more is done.
 */
export const askApproval: Step = async (context) => {
  const run = runStateOf(context.state);
  if (!run) return runFails('other', 'state_incomplete');
  const waiting = run.documents.filter((entry) => entry.stage === 'waiting');
  if (waiting.length === 0) return { outcome: 'skipped' };
  const reason = approvalReason(
    waiting.map((entry) => ({ index: entry.index, reason: entry.waitingFor ?? '' })),
  );
  return held({
    summary: 'Waiting for approval',
    heldReason: reason,
    reason,
    state: context.state,
    documents: runDocumentsOf(run.documents, context.request, artifactIdOf(context.state)),
  });
};

/** The documents that waited and still go to QuickBooks after the approval. */
function waitedForQuickBooks(context: StepContext): Entry[] {
  const run = runStateOf(context.state);
  if (!run || context.request.continuation === undefined) return [];
  if (!quickBooksRun(run, context.request)) return [];
  return run.documents.filter((entry) => entry.stage === 'waiting' && planned(entry));
}

/**
 * `confirm-company` — after the approval, ONCE for every document that waited for QuickBooks: v2's
 * check that QuickBooks is still connected to the company they were checked against. Another
 * company, or no answer, keeps them all out of QuickBooks, their details saved (v2's decision 6).
 */
export function confirmCompanyOnce(clock: Clock): Step {
  const step = confirmCompany(clock);
  return async (context) => {
    // The held state comes back whole, or nothing is written (v2's held-state guard).
    if (!heldWhole(context)) return runFails('other', 'state_incomplete');
    const waited = waitedForQuickBooks(context);
    const [first] = waited;
    if (first === undefined) return { outcome: 'skipped' };
    const result = await step({ ...context, state: first.engine });
    if (result.outcome !== 'failed' || result.failureReason !== undefined) return result;
    return { ...result, state: stopAll(context.state, waited, result.state) };
  };
}

/** Every document that waited for QuickBooks, stopped as the company check stopped the first. */
function stopAll(state: JsonObject, waited: readonly Entry[], after: JsonObject | undefined) {
  const run = runStateOf(state);
  const stop = (after?.quickBooks ?? { notRecorded: NOT_RECORDED.no_answer }) as JsonObject;
  const indexes = new Set(waited.map((entry) => entry.index));
  return withEntries(
    state,
    (run?.documents ?? []).map((entry) =>
      indexes.has(entry.index) ? stopped(entry, stop) : entry,
    ),
  );
}

/**
 * Whether the held state read back whole: on the QuickBooks path, each document that waited to be
 * recorded — not one that waits for a gap its reads could not fill — still holds decide's plan.
 */
function heldWhole(context: StepContext): boolean {
  const run = runStateOf(context.state);
  if (!run) return false;
  if (context.request.continuation === undefined || !quickBooksRun(run, context.request)) {
    return true;
  }
  return run.documents.every(
    (entry) =>
      entry.stage !== 'waiting' ||
      (entry.kind !== 'record' && entry.kind !== 'statement') ||
      entry.unsettled !== undefined ||
      entry.engine.quickBooks !== undefined ||
      readSaved(entry.engine) !== undefined,
  );
}

/** confirm-company given up on after its repeats: every document that waited, not recorded. */
export function confirmCompanyGaveUp(context: StepContext) {
  const waited = waitedForQuickBooks(context);
  if (waited.length === 0) return undefined;
  return {
    outcome: 'failed' as const,
    summary: notRecordedLine('no_answer'),
    state: stopAll(context.state, waited, undefined),
  };
}

/**
 * `save-approved` — after the approval, every document that waited and was not recorded: saved —
 * with "None", or a page or document QuickBooks has no record for — or, on the QuickBooks path, a
 * document still missing what QuickBooks needs, "not recorded" with the reason (B4).
 */
export const saveApproved: Step = async (context) => {
  const run = runStateOf(context.state);
  if (!run) return runFails('other', 'state_incomplete');
  if (context.request.continuation === undefined) return { outcome: 'skipped' };
  const waited = run.documents.filter((entry) => entry.stage === 'waiting');
  if (waited.length === 0) return { outcome: 'skipped' };
  const quickBooks = vendorChoiceOf(context.request.config) === QUICKBOOKS;
  const done = waited.map((entry): Entry => {
    const kept =
      quickBooks && entry.unsettled !== undefined
        ? stopped(entry, { notRecorded: DOUBTS[entry.unsettled] })
        : entry;
    return { ...kept, stage: 'done', afterApproval: true };
  });
  const byIndex = new Map(done.map((entry) => [entry.index, entry]));
  return {
    outcome: 'ok',
    summary: savedLine(done, context),
    state: withEntries(
      context.state,
      run.documents.map((entry) => byIndex.get(entry.index) ?? entry),
    ),
  };
};
