import assert from 'node:assert/strict';

import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import type {
  InvokeRequest,
  JsonObject,
  Manifest,
  ModelRequest,
  RunDocument,
  RunResult,
} from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { receipt } from './check-world.js';
import {
  QUICKBOOKS,
  completion,
  documentAnswer,
  isSecondRead,
  jpeg,
  lines,
  partAnswer,
  positionsOf,
  secondAnswer,
  setUp,
  verifyAnswer,
} from './fixtures.js';
import { seededCompany } from './lookups-world.js';
import { assertResultValid } from './output-schema.js';

/**
 * v3's world: whole runs of a file holding several documents — one photo of three receipts from
 * three sellers, the owner's run 793eef82 of 2026-10-15 — on the kit's simulator, holding the
 * made-up company's vendors; the model reading the documents a test gives, and the second read
 * agreeing with each unless told otherwise; and, when the run holds, the approval's continuation.
 */

/** The continuation's run id: the run whose timeline shows what it records. */
export const CONTINUATION_RUN_ID = '88888888-8888-4888-8888-888888888888';

/** Receipt 1: a hardware store the company knows, by card 4417, three lines. */
export const TIDEWELL = documentAnswer(receipt(), {
  vendorAddress: '410 Harbor Rd',
  vendorCity: 'Fresno, CA 93721',
  numberLabel: 'Receipt #',
  documentTime: '09:12',
});

/** Receipt 2: an office supplier the company knows, by card 4417, one line. */
export const HARROWGATE = documentAnswer(
  receipt({
    vendorName: 'Harrowgate Office Supply',
    documentNumber: 'R-2201',
    documentDate: '2026-09-28',
    subtotal: 21.6,
    tax: 1.8,
    total: 23.4,
    spendType: 'office_supplies',
    lineItems: [{ amount: 21.6 }],
  }),
  { numberLabel: 'Receipt', documentTime: '11:05' },
);

/**
 * Receipt 3: a seller the company has never bought from — Lowe's in Fresno — every field v3 reads:
 * its place, its store, the time, the number's label, a reference, each line's words, quantity and
 * unit price.
 */
export const LOWES = documentAnswer(
  receipt({
    vendorName: "Lowe's",
    documentNumber: '48291',
    documentDate: '2026-10-14',
    subtotal: 15.92,
    tax: 1.27,
    total: 17.19,
    spendType: 'materials',
    lineItems: [{ amount: 15.92 }],
  }),
  {
    vendorAddress: '2150 W Shaw Ave',
    vendorCity: 'Fresno, CA 93711',
    storeNumber: '1234',
    numberLabel: 'Trans #',
    references: [{ label: 'Register', value: '07' }],
    documentTime: '14:32',
    lineItems: [{ description: '2X4-8 STUD', quantity: 4, unitPrice: 3.98, amount: 15.92 }],
  },
);

/** One photo, three receipts from three sellers. */
export const THREE_RECEIPTS = [TIDEWELL, HARROWGATE, LOWES];

export interface DocumentsRun {
  /** Each document as v3 reads it, in the file's order; or whole parts, by where each starts. */
  readonly documents?: readonly JsonObject[];
  readonly parts?: (call: ModelRequest) => JsonObject;
  /** The second read's answer for one document, by its place; a reader who agrees by default. */
  readonly second?: (position: number) => JsonObject;
  /** How many documents the second read counts in the file; the first read's by default. */
  readonly secondCount?: number;
  readonly config?: JsonObject;
  /** No vendor in the company: every seller is new. */
  readonly bare?: boolean;
  readonly company?: (simulator: QuickBooksSimulator) => void;
  /** The manifests the run's automation is given; the served ones (v4's) by default. */
  readonly manifests?: readonly Manifest[];
}

/** A whole run of v3 on a photo of the documents given. */
export async function documentsRun(run: DocumentsRun) {
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.expenseAmountSearchable = true;
  if (!run.bare) seededCompany(simulator);
  run.company?.(simulator);
  const world = setUp({
    simulator,
    through: 'all',
    file: jpeg(),
    config: run.config ?? QUICKBOOKS,
    ...(run.manifests === undefined ? {} : { manifests: run.manifests }),
  });
  const documents = run.documents ?? THREE_RECEIPTS;
  world.platform.model = (call, model) => {
    if (!isSecondRead(call)) {
      return Promise.resolve(completion(model, run.parts?.(call) ?? partAnswer([...documents])));
    }
    const named = positionsOf(call).map(
      (position) =>
        [position, run.second?.(position) ?? secondOf(documents[position - 1])] as const,
    );
    const count = run.secondCount ?? documents.length;
    return Promise.resolve(completion(model, verifyAnswer(named, count)));
  };
  const result = await world.run();
  assertResultValid(result, 'the first run');
  return { ...world, result };
}

/** A v3 document's second read by a reader who agrees: its 14 fields. */
function secondOf(document: JsonObject | undefined): JsonObject {
  return secondAnswer({ ...(document ?? {}) });
}

export type Run = Awaited<ReturnType<typeof documentsRun>>;

/** The documents a result carries: a success's, or a held run's. */
export function documentsOf(result: RunResult): readonly RunDocument[] {
  assert.notEqual(result.outcome, 'failed', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'success' | 'held' }>).documents ?? [];
}

/** Each document's status, in order. */
export const statuses = (result: RunResult) => documentsOf(result).map((each) => each.status);

/** The approval's continuation, run by the first run's automation on its platform and QuickBooks. */
export async function approve(first: Run, config: JsonObject = first.request.config) {
  assert.equal(first.result.outcome, 'held', JSON.stringify(first.result).slice(0, 300));
  const held = first.result as Extract<RunResult, { outcome: 'held' }>;
  const request: InvokeRequest = {
    ...first.request,
    runId: CONTINUATION_RUN_ID,
    input: {},
    config,
    deadline: new Date(Date.now() + 900_000).toISOString(),
    continuation: {
      ofRunId: first.request.runId,
      kind: 'approval',
      stepId: held.held.stepId,
      decision: 'approved',
      decidedAt: '2026-10-15T10:00:00.000Z',
      state: held.held.state,
    },
  };
  const steps = first.platform.steps.length;
  const calls = first.platform.providerCalls.length;
  const result = await first.automation.execute(request, first.platform);
  assertResultValid(result, 'the continuation');
  return {
    request,
    result,
    steps: lines(first.platform).slice(steps),
    providerCalls: first.platform.providerCalls.slice(calls),
  };
}

/** The provider calls of one operation, with the key each was sent under. */
export function keysOf(world: { platform: Run['platform'] }, operation: string): string[] {
  return world.platform.providerCalls
    .filter((call) => call.operation === operation)
    .map((call) => call.idempotencyKey);
}
