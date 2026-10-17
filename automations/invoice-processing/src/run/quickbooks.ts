import { sameName } from '@autom8x/automation-kit/values';
import {
  isObject,
  type InvokeRequest,
  type JsonObject,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { runFails } from '../outcome.js';
import { NOT_RECORDED, QUICKBOOKS, vendorChoiceOf } from '../quickbooks-path.js';
import { readSaved } from '../writes/saved-state.js';
import { documentOf } from './check.js';
import { stopped } from './fan-out.js';
import { runStateOf, withEntries, type Entry, type RunState } from './state.js';

/**
 * Which documents go to QuickBooks, and the three reads the run makes once for all of them (v2's
 * `read-company`, `read-preferences` and `find-accounts`, unchanged): only when QuickBooks is the
 * flow's vendor and some document it may record or compare is left — a file of quotes calls
 * QuickBooks for nothing. A read that fails keeps every document out of QuickBooks, their details
 * saved (v2's decision 6); the run goes on.
 */

/** QuickBooks is the flow's vendor and nothing has stopped it for the whole run. */
export function quickBooksRun(state: JsonObject, request: Pick<InvokeRequest, 'config'>): boolean {
  return vendorChoiceOf(request.config) === QUICKBOOKS && state.quickBooks === undefined;
}

/** A document checked and still headed for QuickBooks: read, usable, nothing stopping it. */
export function forQuickBooks(entry: Entry): boolean {
  return (
    entry.stage === 'read' &&
    (entry.kind === 'record' || entry.kind === 'statement') &&
    entry.unsettled === undefined &&
    entry.engine.quickBooks === undefined &&
    documentOf(entry.engine) !== undefined
  );
}

/** A decided document whose planned record QuickBooks may still write: its plan, nothing stopping it. */
export function planned(entry: Entry): boolean {
  return entry.engine.quickBooks === undefined && readSaved(entry.engine) !== undefined;
}

/** Whether this step of the run reaches QuickBooks for a document at all. */
function anyForQuickBooks(run: RunState, request: Pick<InvokeRequest, 'config'>): boolean {
  return quickBooksRun(run, request) && run.documents.some(forQuickBooks);
}

/** One of v2's run-level reads, made once, only when a document needs QuickBooks. */
export function onceForAll(step: Step, after?: (state: JsonObject) => JsonObject): Step {
  return async (context) => {
    const run = runStateOf(context.state);
    if (!run) return runFails('other', 'state_incomplete');
    if (!anyForQuickBooks(run, context.request)) return { outcome: 'skipped' };
    const result: StepResult = await step(context);
    if (result.outcome !== 'ok' || result.state === undefined || after === undefined) return result;
    return { ...result, state: after(result.state) };
  };
}

/**
 * After read-company: each document the company issued itself is not recorded (v2's C10, weighed
 * here because the company is known only now) — "your own company issued it".
 */
export function withOwnCompany(state: JsonObject): JsonObject {
  const run = runStateOf(state);
  const { company } = state;
  if (!run || !isObject(company)) return state;
  const names = [company.name, company.legalName].filter((name) => typeof name === 'string');
  return withEntries(
    state,
    run.documents.map((entry) => {
      const document = documentOf(entry.engine);
      const own =
        forQuickBooks(entry) &&
        document !== undefined &&
        names.some((name) => sameName(document.seller, name));
      return own ? stopped(entry, { notRecorded: NOT_RECORDED.own_company }) : entry;
    }),
  );
}
