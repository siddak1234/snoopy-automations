import type { InvokeRequest, JsonObject, RunDocument } from '@autom8x/automation-sdk';

import { comparedOutput, recordedOutput } from '../output.js';
import { quickBooksStateOf } from '../quickbooks-path.js';
import { createdOf, newVendorOf, readSaved, statementOf } from '../writes/saved-state.js';
import { runDocumentsOf, summarised } from './documents.js';
import { runStateOf, type Entry } from './state.js';
import { runSummary } from './words.js';

/**
 * The run's result once its pipeline ends (the session's spec, §3.5 and §3.6): the documents, whole
 * (`documents.ts`); the summary — one document as v2 said it, several counted; and the output, for
 * each document the record made, the statement compared, or the details saved. A held run ends at
 * `ask-approval` instead, with the same documents (`approval.ts`).
 */

export interface RunOutcome {
  readonly output: JsonObject;
  readonly summary: string;
  readonly documents: readonly RunDocument[];
}

/** One document's output item: its place in the file, and v2's record or comparison, or saved. */
function outputOf(entry: Entry): JsonObject {
  const index = { index: entry.index };
  const created = createdOf(entry.engine);
  const saved = readSaved(entry.engine);
  if (created && saved) {
    const decidedBy = entry.afterApproval === true ? 'after approval' : 'automatically';
    return {
      ...index,
      ...recordedOutput(saved, created, newVendorOf(entry.engine) ?? null, decidedBy),
    };
  }
  // A guard that should never fire (v2's): the record stands, named as far as the state says.
  if (created) {
    return { ...index, outcome: 'recorded', record: { type: created.record, id: created.id } };
  }
  const statement = statementOf(entry.engine);
  if (statement) return { ...index, ...comparedOutput(statement) };
  const stop = quickBooksStateOf(entry.engine);
  return {
    ...index,
    outcome: 'saved',
    documentType: entry.read.type,
    notRecorded: stop && 'notRecorded' in stop ? stop.notRecorded : null,
    unconfirmed: stop !== null && stop !== undefined && 'unconfirmed' in stop,
  };
}

/** The result of a state whose documents are all done; a state holding none is a fault. */
export function runResult(state: JsonObject, request: Pick<InvokeRequest, 'config'>): RunOutcome {
  const run = runStateOf(state);
  if (!run) throw new Error('the run ended without its documents');
  return {
    output: { outcome: 'documents', documents: run.documents.map(outputOf) },
    summary: runSummary(run.documents.map((entry) => summarised(entry, request))),
    documents: runDocumentsOf(run.documents, request),
  };
}
