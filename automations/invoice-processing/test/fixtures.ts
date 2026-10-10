import { resolve } from 'node:path';

import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import {
  idempotencyKeyFor,
  readManifests,
  type ArtifactReference,
  type InvokeRequest,
  type JsonObject,
  type Logger,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  artifactFixture,
  invokeFixture,
  refusalFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';

/**
 * The suite's world: the repository's own v1 manifest, a run started with one upload,
 * QuickBooks behind the platform (the kit's simulator, holding Connections to its
 * rules), and a clock that records QuickBooks' 60-second waits instead of waiting.
 */

export const manifestsRoot = resolve(import.meta.dirname, '..', '..', '..', 'manifests');
export const manifests = readManifests(manifestsRoot, TEMPLATE_ID);

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
  simulator?: QuickBooksSimulator;
  runId?: string;
}

export function setUp(options: SetUp = {}) {
  let now = Date.now();
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
  const automation = define(manifests, { clock, log: (...line) => logs.push(line) });
  const simulator = options.simulator ?? new QuickBooksSimulator({ refusal: refusalFixture });
  const platform = new RecordingPlatform();
  platform.provider = simulator.provider;
  platform.artifacts = options.file === null ? [] : [options.file ?? pdf()];
  const request: InvokeRequest = invokeFixture({
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    config: options.config ?? { expenseAccount: 'Utilities:Electric' },
    input: options.input ?? { invoiceFile: FILE_ID },
    deadline: new Date(now + (options.deadlineInMs ?? 900_000)).toISOString(),
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

/** The provider calls one step made: each under the step's one key, which this asserts. */
export function callsOf(platform: RecordingPlatform, request: InvokeRequest, stepId: string) {
  const key = idempotencyKeyFor(request.runId, stepId);
  return platform.providerCalls
    .filter((call) => call.idempotencyKey === key)
    .map(({ providerId, operation, input }) => ({ providerId, operation, input }));
}

/** The run's text a person reads — every timeline line and the result — as one string. */
export function everythingSaid(platform: RecordingPlatform, result: unknown): string {
  return JSON.stringify({ steps: platform.steps, result });
}
