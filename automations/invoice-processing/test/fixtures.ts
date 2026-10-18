import { resolve } from 'node:path';

import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import {
  defineAutomation,
  idempotencyKeyFor,
  readManifests,
  type ArtifactReference,
  type Automation,
  type InvokeRequest,
  type JsonObject,
  type Logger,
  type Manifest,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  artifactFixture,
  invokeFixture,
  refusalFixture,
} from '@autom8x/automation-sdk/testing';

import {
  PROMPTS,
  RETRY,
  TEMPLATE_ID,
  define,
  perDocumentSpecs,
  pipelineSteps,
  servedManifests,
} from '../src/automation.js';
import { recoverQuickBooks, withFixedSentences } from '../src/failures.js';
import { EXPENSE_SEARCH, type ExpenseSearch } from '../src/lookups/expense-search.js';
import { reads } from './answers.js';

/**
 * The suite's world: the repository's own v4 manifest — the one this code serves, v3's steps under
 * v4's five groups — a run started
 * with one upload and the vendor QuickBooks, QuickBooks behind the platform (the kit's simulator,
 * holding Connections to its rules), a model that reads the file as one document, `GOOD_ANSWER`,
 * or as the documents a test gives — and, asked the second read's prompt, gives each document's 14
 * fields again — and a clock that records QuickBooks' 60-second waits instead of waiting.
 *
 * The run goes `through` one step of the manifest's pipeline — by default `verify-read`, its
 * result then the whole state the steps so far leave — or `all`, v3 whole, with its own result.
 */

export {
  GOOD_ANSWER,
  asTexts,
  documentAnswer,
  partAnswer,
  secondAnswer,
  verifyAnswer,
  isSecondRead,
  positionsOf,
  reads,
  completion,
} from './answers.js';

export const manifestsRoot = resolve(import.meta.dirname, '..', '..', '..', 'manifests');
export const manifests = servedManifests(readManifests(manifestsRoot, TEMPLATE_ID));

/** The flow's settings with QuickBooks chosen; `NONE` with "None". */
export const QUICKBOOKS: JsonObject = { vendor: 'quickbooks' };
export const NONE: JsonObject = { vendor: 'none' };

export const FILE_ID = '44444444-4444-4444-8444-444444444444';
/** Never to appear in a timeline line, a state or a reason. */
export const FILENAME = 'acme-invoice-0042.pdf';

/** Fields of a reference to change; `undefined` is a field the platform did not send. */
export type Overrides = { [K in keyof ArtifactReference]?: ArtifactReference[K] | undefined };

/** A 2-page PDF as the platform measured it at upload. */
export function pdf(overrides: Overrides = {}): ArtifactReference {
  const reference: Record<string, unknown> = {
    ...artifactFixture({
      artifactId: FILE_ID,
      filename: FILENAME,
      contentType: 'application/pdf',
      sizeBytes: 184_203,
      sha256: 'ab'.repeat(32),
      measuredKind: 'pdf',
      pageCount: 2,
      widthPixels: null,
      heightPixels: null,
    }),
    ...overrides,
  };
  for (const [key, value] of Object.entries(reference)) {
    if (value === undefined) delete reference[key];
  }
  return reference as unknown as ArtifactReference;
}

/** A phone photo as the platform measured it: 2,576 x 1,932 px. */
export function jpeg(overrides: Overrides = {}): ArtifactReference {
  return pdf({
    filename: 'IMG_0042.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 812_004,
    measuredKind: 'jpeg',
    pageCount: null,
    widthPixels: 2_576,
    heightPixels: 1_932,
    ...overrides,
  });
}

/** A scanned page as the platform measured it: a PNG of 1,200 x 900 px. */
export function png(overrides: Overrides = {}): ArtifactReference {
  return jpeg({
    filename: 'scan-0042.png',
    contentType: 'image/png',
    sizeBytes: 95_310,
    measuredKind: 'png',
    widthPixels: 1_200,
    heightPixels: 900,
    ...overrides,
  });
}

export interface SetUp {
  /** The upload the run was given; `null` for a run given none. */
  file?: ArtifactReference | null;
  config?: JsonObject;
  input?: JsonObject;
  /** Milliseconds from now to the run's deadline. */
  deadlineInMs?: number;
  /** The run's clock at its start, for the checks' date; the real time by default. */
  now?: number;
  simulator?: QuickBooksSimulator;
  runId?: string;
  /** The last step the run takes (default `verify-read`); `all` is the whole of v4 (v3's steps). */
  through?: string;
  /**
   * Sandbox S4's answer for the run (default `EXPENSE_SEARCH`). A simulator made here searches an
   * expense by amount only under `amount`, as D21 assumes Intuit does.
   */
  expenseSearch?: ExpenseSearch;
  /** The manifests the whole run's `define` is given (`through: 'all'`); the served ones by default. */
  manifests?: readonly Manifest[];
}

/** The automation as `define` builds it, its pipeline cut after `stepId`, its result the whole state. */
function automationThrough(
  stepId: string,
  dependencies: { clock: Clock; log: Logger; expenseSearch: ExpenseSearch },
): Automation {
  const [manifest] = manifests;
  const at = manifest?.pipeline.findIndex((step) => step.id === stepId) ?? -1;
  if (!manifest || at < 0) throw new Error(`v4 declares no step ${stepId}`);
  const pipeline = manifest.pipeline.slice(0, at + 1);
  const ids = pipeline.map((step) => step.id);
  const steps = pipelineSteps(dependencies.clock, dependencies.expenseSearch, dependencies.log);
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [{ ...manifest, pipeline }],
    prompts: PROMPTS,
    steps: Object.fromEntries(ids.map((id) => [id, steps[id]!])),
    retry: Object.fromEntries(Object.entries(RETRY).filter(([id]) => ids.includes(id))),
    recover: recoverQuickBooks(
      dependencies.log,
      perDocumentSpecs(dependencies.clock, dependencies.expenseSearch),
    ),
    result: (state) => ({ output: state }),
  });
  return withFixedSentences(automation, dependencies.log);
}

export function setUp(options: SetUp = {}) {
  let now = options.now ?? Date.now();
  const waits: number[] = [];
  const clock = {
    now: () => now,
    sleep: (milliseconds: number) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  };
  const logs: Parameters<Logger>[] = [];
  const log: Logger = (...line) => logs.push(line);
  const expenseSearch = options.expenseSearch ?? EXPENSE_SEARCH;
  const through = options.through ?? 'verify-read';
  const automation =
    through === 'all'
      ? define(options.manifests ?? manifests, { clock, log, expenseSearch })
      : automationThrough(through, { clock, log, expenseSearch });
  const simulator = options.simulator ?? new QuickBooksSimulator({ refusal: refusalFixture });
  if (!options.simulator) simulator.expenseAmountSearchable = expenseSearch === 'amount';
  const platform = new RecordingPlatform();
  platform.provider = simulator.provider;
  platform.model = reads();
  platform.artifacts = options.file === null ? [] : [options.file ?? pdf()];
  const request: InvokeRequest = invokeFixture({
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    templateId: TEMPLATE_ID,
    templateVersion: 4,
    config: options.config ?? QUICKBOOKS,
    input: options.input ?? { invoiceFile: FILE_ID },
    deadline: new Date(Math.max(now, Date.now()) + (options.deadlineInMs ?? 900_000)).toISOString(),
  });
  return {
    automation,
    simulator,
    platform,
    request,
    waits,
    logs,
    run: () => automation.execute(request, platform),
  };
}

/** Each reported step as `[stepId, outcome, summary]`. */
export function lines(platform: RecordingPlatform): [string, string, string][] {
  return platform.steps.map((step) => [step.stepId, step.outcome, step.summary]);
}

/**
 * The provider calls one step made under one key — the step's own, or one document's part of it
 * (`d1`, `d1-a`, …), which this asserts.
 */
export function callsOf(
  platform: RecordingPlatform,
  request: InvokeRequest,
  stepId: string,
  part?: string,
) {
  const step = idempotencyKeyFor(request.runId, stepId);
  const key = part === undefined ? step : `${step}.${part}`;
  return platform.providerCalls
    .filter((call) => call.idempotencyKey === key)
    .map(({ providerId, operation, input }) => ({ providerId, operation, input }));
}

/** The run's text a person reads — every timeline line and the result — as one string. */
export function everythingSaid(platform: RecordingPlatform, result: unknown): string {
  return JSON.stringify({ steps: platform.steps, result });
}
