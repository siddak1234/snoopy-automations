import assert from 'node:assert/strict';

import type { InvokeRequest, JsonObject, RunResult } from '@autom8x/automation-sdk';

import { runStateOf } from '../src/run/state.js';
import { lines } from './fixtures.js';
import { routeRun, type RouteRun } from './lookups-world.js';

/**
 * The writes' world: a whole run of one document on the kit's simulator (`routeRun`), and — when
 * it held — the approval's continuation the platform mints, run by the same automation against the
 * same QuickBooks: a new run, its own id and keys, `input` empty, the held state handed back
 * verbatim, the settings as they are at approval (ip-review
 * design-after-approval-writes-notify-tests.json cross_cutting[0]). Readers for what each run
 * wrote, and what it said.
 */

/** The continuation's run id: the run whose timeline shows the record. */
export const CONTINUATION_RUN_ID = '88888888-8888-4888-8888-888888888888';

/** The QuickBooks writes the platform declares. */
const WRITES = new Set([
  'vendor.create',
  'bill.create',
  'purchase.create',
  'vendorCredit.create',
  'journalEntry.create',
]);

export type Run = Awaited<ReturnType<typeof routeRun>>;

/** The whole first run of a document. */
export const firstRun = (run: RouteRun): Promise<Run> => routeRun(run);

export interface Approval {
  readonly decision?: 'approved' | 'rejected';
  readonly runId?: string;
  /** The settings when the approval comes; the first run's by default. */
  readonly config?: JsonObject;
  /**
   * The document's state handed back in place of the held one — decide's saved data, as v2's
   * held state was — inside the run's held state; the held state as it is by default.
   */
  readonly state?: JsonObject;
  /** The continuation's deadline: a fresh one by default. */
  readonly deadline?: string;
}

/**
 * A continuation's deadline too near for the SDK's step retry, which waits at least 10 s before a
 * repeat: a write that throws is not repeated, and the run's `recover` ends the step at once.
 */
export const noTimeToRepeat = () => new Date(Date.now() + 5_000).toISOString();

/** The held state the platform keeps: fails the test when the first run did not hold. */
export function heldRunState(run: Run): JsonObject {
  assert.equal(run.result.outcome, 'held', JSON.stringify(run.result).slice(0, 300));
  return (run.result as Extract<RunResult, { outcome: 'held' }>).held.state;
}

/** One held state's first document's state: decide's saved data, as v2's held state was. */
export const documentState = (state: JsonObject): JsonObject =>
  runStateOf(state)?.documents[0]?.engine ?? {};

/** The one document's state in the held state: decide's saved data, as v2's held state was. */
export function heldState(run: Run): JsonObject {
  const held = runStateOf(heldRunState(run));
  assert.ok(held, 'the held state holds its documents');
  return held.documents[0]!.engine;
}

/** The run's held state with its one document's state replaced. */
function withDocumentState(run: Run, engine: JsonObject): JsonObject {
  const held = heldRunState(run);
  const documents = runStateOf(held)?.documents ?? [];
  return {
    ...held,
    documents: documents.map((entry, at) => (at === 0 ? { ...entry, engine } : entry)),
  };
}

/**
 * The continuation an approval mints, run by the first run's automation on its platform and its
 * QuickBooks; the steps it reported, and its result.
 */
export async function approve(run: Run, approval: Approval = {}) {
  const state =
    approval.state === undefined ? heldRunState(run) : withDocumentState(run, approval.state);
  const request: InvokeRequest = {
    ...run.request,
    runId: approval.runId ?? CONTINUATION_RUN_ID,
    input: {},
    config: approval.config ?? run.request.config,
    deadline: approval.deadline ?? new Date(Date.now() + 900_000).toISOString(),
    continuation: {
      ofRunId: run.request.runId,
      kind: 'approval',
      stepId: 'ask-approval',
      decision: approval.decision ?? 'approved',
      decidedAt: '2026-10-11T10:00:00.000Z',
      state,
    },
  };
  const before = run.platform.steps.length;
  const calls = run.platform.providerCalls.length;
  const mails = run.platform.mails.length;
  const result = await run.automation.execute(request, run.platform);
  return {
    request,
    result,
    /** `[stepId, outcome, summary]` for each step the continuation reported. */
    steps: lines(run.platform).slice(before),
    providerCalls: run.platform.providerCalls.slice(calls),
    mails: run.platform.mails.slice(mails),
  };
}

/** The writes among provider calls, each `[operation, input]`. */
export function writesOf(calls: readonly { operation: string; input: JsonObject }[]) {
  return calls
    .filter((call) => WRITES.has(call.operation))
    .map((call) => [call.operation, call.input] as const);
}

/** The run's one document's output item — v2's whole output, with its place — or a failed test. */
export function outputOf(result: RunResult): JsonObject {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 400));
  const output = (result as Extract<RunResult, { outcome: 'success' }>).output ?? {};
  const [first] = Array.isArray(output.documents) ? (output.documents as JsonObject[]) : [];
  const { index: _index, ...item } = first ?? {};
  return item;
}

/**
 * The made-up company stating its own-numbers setting for expenses and vendor credits
 * (`VendorAndPurchasesPrefs.UseCustomTxnNumbers`): off, QuickBooks numbers them itself.
 */
export const ownNumbers =
  (value: 'true' | 'false') =>
  (sim: Parameters<NonNullable<RouteRun['company']>>[0]): void => {
    const other = sim.company.preferences.OtherPrefs as JsonObject;
    (other.NameValue as JsonObject[]).push({
      Name: 'VendorAndPurchasesPrefs.UseCustomTxnNumbers',
      Value: value,
    });
  };

/** The memo's first sentence for a run. */
export const runLine = (runId: string) => `Created by Autom8x Invoice Processing, run ${runId}.`;

/** One account-based expense line, as create-record sends it. */
export function expenseLine(amount: number, description: string, account: string): JsonObject {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amount,
    Description: description,
    AccountBasedExpenseLineDetail: { AccountRef: { value: account } },
  };
}
