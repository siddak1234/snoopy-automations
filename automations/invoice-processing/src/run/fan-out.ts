import type {
  InvokeRequest,
  JsonObject,
  Step,
  StepContext,
  StepPlatform,
  StepResult,
} from '@autom8x/automation-sdk';

import { runFails } from '../outcome.js';
import { NOT_RECORDED, UNCONFIRMED_LINE, notRecordedLine } from '../quickbooks-path.js';
import {
  engineOf,
  engineState,
  runStateOf,
  withEntries,
  type Entry,
  type RunState,
} from './state.js';

/**
 * One step, once per document (the session's spec, S17): v2's QuickBooks steps run on each
 * document's own state in turn, each call under its own key — a step has ONE idempotency key, and
 * the platform answers a second call under it from the first's record, so each document's calls
 * name a part, `d<index>`, and a second call for it in the same step `d<index>-a`, then `-b`. Every
 * QuickBooks write of a document carries its own Intuit `requestid`.
 *
 * What each document's call left is kept for the run, so the runner's repeat of the step after a
 * transient failure goes on from the document it failed at; the parts it already sent are not
 * sent again. When the repeats are spent, `gaveUp` ends the step for the documents it had not
 * finished — QuickBooks "didn't answer", or for a write it may have made, "didn't confirm" — and
 * the run goes on (v2's decision 6, per document): one document never fails the others.
 */

/** A document's part of a step's key: `d<index>`, and its second and third calls `d<index>-a`, `-b`. */
export function partOf(index: number, call = 0): string {
  return call === 0 ? `d${index}` : `d${index}-${String.fromCharCode(96 + call)}`;
}

/**
 * The step's platform with every call under one part's key. The same object for the same part on
 * every attempt — the runner hands each attempt of a step the one platform — so the kit's mark of
 * a write that went unanswered (`writeQuickBooks`) stays with that document's write.
 */
const parts = new WeakMap<StepPlatform, Map<string, StepPlatform>>();

export function partPlatform(platform: StepPlatform, part: string): StepPlatform {
  let byPart = parts.get(platform);
  if (!byPart) {
    byPart = new Map();
    parts.set(platform, byPart);
  }
  let found = byPart.get(part);
  if (!found) {
    found = {
      ...platform,
      callProvider: (request) => platform.callProvider(request, { part }),
      sendMail: (mail) => platform.sendMail(mail, { part }),
    };
    byPart.set(part, found);
  }
  return found;
}

/** v2's step for one document: its state as v2 kept it, its calls under the part's key. */
export function runForDocument(
  step: Step,
  context: StepContext,
  run: RunState,
  entry: Entry,
  part: string,
): Promise<StepResult> {
  return step({
    ...context,
    state: engineState(run, entry),
    platform: partPlatform(context.platform, part),
  });
}

/** What one document's turn of a step came to: the entry and its line, or the run's end. */
export type Turn =
  | { readonly entry: Entry; readonly summary: string | null; readonly failed: boolean }
  | { readonly end: StepResult };

/** A v2 step's result for one document, as a turn: its state kept, a failure reason the run's end. */
export function turnOf(entry: Entry, result: StepResult): Turn {
  switch (result.outcome) {
    case 'skipped':
      return { entry, summary: null, failed: false };
    case 'held':
      return { end: runFails('other', 'unexpected_hold') };
    case 'ok':
    case 'failed':
      if (result.outcome === 'failed' && result.failureReason !== undefined) return { end: result };
      return {
        entry:
          result.state === undefined ? entry : { ...entry, engine: engineOf(entry, result.state) },
        summary: result.summary,
        failed: result.outcome === 'failed',
      };
  }
}

/** One step done per document. */
export interface FanOut {
  /** Whether the document takes this step. */
  eligible(entry: Entry, run: RunState, request: InvokeRequest): boolean;
  /** Its turn: v2's step or steps on its state, under its parts; `earlier` the step's turns before it. */
  turn(
    context: StepContext,
    entry: Entry,
    run: RunState,
    earlier: readonly Extract<Turn, { entry: Entry }>[],
  ): Promise<Turn>;
  /** The step's line from each document's: one as v2 said it, several counted. */
  line(turns: readonly Extract<Turn, { entry: Entry }>[]): string;
  /** Whether it writes: a document it gave up on mid-write may have been recorded. */
  readonly writes?: boolean;
}

type Done = Extract<Turn, { entry: Entry }>;

/** Each run's finished turns, by step and document: kept across the runner's repeats. */
const finished = new WeakMap<InvokeRequest, Map<string, Map<number, Done>>>();

function finishedFor(request: InvokeRequest, stepId: string): Map<number, Done> {
  let bySteps = finished.get(request);
  if (!bySteps) {
    bySteps = new Map();
    finished.set(request, bySteps);
  }
  let byIndex = bySteps.get(stepId);
  if (!byIndex) {
    byIndex = new Map();
    bySteps.set(stepId, byIndex);
  }
  return byIndex;
}

/** The document each thrown error was thrown for. */
const thrownFor = new WeakMap<object, number>();

export function fanOut(spec: FanOut): Step {
  return async (context) => {
    const run = runStateOf(context.state);
    if (!run) return runFails('other', 'state_incomplete');
    const done = finishedFor(context.request, context.stepId);
    const entries = [...run.documents];
    const turns: Done[] = [];
    let changed = false;
    for (const [at, entry] of entries.entries()) {
      if (!spec.eligible(entry, run, context.request)) continue;
      let turn: Turn | undefined = done.get(entry.index);
      if (!turn) {
        try {
          turn = await spec.turn(context, entry, run, turns);
        } catch (error) {
          // Thrown on unchanged, for the runner's repeat: noted against the document it was for.
          if (typeof error === 'object' && error !== null) thrownFor.set(error, entry.index);
          throw error;
        }
        if ('end' in turn) return turn.end;
        done.set(entry.index, turn);
      }
      changed ||= turn.entry !== entry || turn.summary !== null;
      entries[at] = turn.entry;
      turns.push(turn);
    }
    // Nothing to do for any document — each of v2's steps skipped it — is a step skipped: no line.
    if (!changed) return { outcome: 'skipped' };
    return {
      outcome: turns.some((turn) => turn.failed) ? 'failed' : 'ok',
      summary: spec.line(turns),
      state: withEntries(context.state, entries),
    };
  };
}

/** A document QuickBooks stopped: why, kept on its state. */
export function stopped(entry: Entry, stop: JsonObject): Entry {
  return { ...entry, engine: { ...entry.engine, quickBooks: stop } };
}

/**
 * The step ended once the runner's repeats are spent: each document it finished as it finished;
 * the one it was writing when nothing answered — or, when the error names none, each it had not
 * finished — "QuickBooks didn't confirm"; every other it had not finished, "not recorded in
 * QuickBooks: QuickBooks didn't answer" — and the run goes on.
 */
export function gaveUp(spec: FanOut, error: unknown, context: StepContext): StepResult | undefined {
  const run = runStateOf(context.state);
  if (!run) return undefined;
  const done = finishedFor(context.request, context.stepId);
  const thrown = typeof error === 'object' && error !== null ? thrownFor.get(error) : undefined;
  const entries = run.documents.map((entry) => {
    const turn = done.get(entry.index);
    if (turn) return turn.entry;
    if (!spec.eligible(entry, run, context.request)) return entry;
    // A write whose error names no document may have been made for any it had not finished.
    return spec.writes === true && (thrown === undefined || entry.index === thrown)
      ? stopped(entry, { unconfirmed: true })
      : stopped(entry, { notRecorded: NOT_RECORDED.no_answer });
  });
  return {
    outcome: 'failed',
    summary: spec.writes === true ? UNCONFIRMED_LINE : notRecordedLine('no_answer'),
    state: withEntries(context.state, entries),
  };
}
