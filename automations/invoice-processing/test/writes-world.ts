import assert from 'node:assert/strict';

import type { InvokeRequest, JsonObject, RunResult } from '@autom8x/automation-sdk';

import { lines } from './fixtures.js';
import { routeRun, type RouteRun } from './lookups-world.js';

/**
 * Group 5's world: a whole run of v1 on the kit's simulator (`routeRun`), and — when decide held it
 * — the approval's continuation the platform mints, run by the same automation against the same
 * QuickBooks: a new run, its own id and keys, `input` empty, the held state handed back verbatim,
 * the settings as they are at approval (ip-review design-after-approval-writes-notify-tests.json
 * cross_cutting[0]). Readers for what each run wrote, and what it said.
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
  /** The state handed back; the held state by default. */
  readonly state?: JsonObject;
  /** The continuation's deadline: a fresh one by default. */
  readonly deadline?: string;
}

/** The held state the platform keeps: fails the test when the first run did not hold. */
export function heldState(run: Run): JsonObject {
  assert.equal(run.result.outcome, 'held', JSON.stringify(run.result).slice(0, 300));
  return (run.result as Extract<RunResult, { outcome: 'held' }>).held.state;
}

/**
 * The continuation an approval mints, run by the first run's automation on its platform and its
 * QuickBooks; the steps it reported, and its result.
 */
export async function approve(run: Run, approval: Approval = {}) {
  const state = approval.state ?? heldState(run);
  const request: InvokeRequest = {
    ...run.request,
    runId: approval.runId ?? CONTINUATION_RUN_ID,
    input: {},
    config: approval.config ?? run.request.config,
    deadline: approval.deadline ?? new Date(Date.now() + 900_000).toISOString(),
    continuation: {
      ofRunId: run.request.runId,
      kind: 'approval',
      stepId: 'decide',
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

/** The run's success output, or a failed test. */
export function outputOf(result: RunResult): JsonObject {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 400));
  return (result as Extract<RunResult, { outcome: 'success' }>).output ?? {};
}

/** The memo's first sentence for a run. */
export const runLine = (runId: string) => `Created by Autom8x Bills & Receipts, run ${runId}.`;

/** One account-based expense line, as create-record sends it. */
export function expenseLine(amount: number, description: string, account: string): JsonObject {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amount,
    Description: description,
    AccountBasedExpenseLineDetail: { AccountRef: { value: account } },
  };
}

/** One journal entry line, as create-record sends it. */
export function journalLine(
  amount: number,
  description: string,
  posting: 'Debit' | 'Credit',
  account: string,
  employee?: string,
): JsonObject {
  return {
    DetailType: 'JournalEntryLineDetail',
    Amount: amount,
    Description: description,
    JournalEntryLineDetail: {
      PostingType: posting,
      AccountRef: { value: account },
      ...(employee === undefined
        ? {}
        : { Entity: { Type: 'Employee', EntityRef: { value: employee } } }),
    },
  };
}
