/**
 * The wire contract, copied deliberately.
 *
 * This file does NOT import the platform's `@snoopy/contracts`, and that is the
 * point. A third-party automation could not import it either — it would have only
 * the published wire format (`contract/schemas` at the repository root). Sharing
 * the package would test the boundary against something no real automation could
 * reproduce.
 *
 * Only the fields an automation reads are declared. An unknown field arriving from
 * the platform is ignored rather than rejected, because the platform may add one at
 * a later contract version and an automation that refuses on sight would break on
 * an addition it does not care about. Fields an automation SENDS are exact: the
 * platform refuses one it does not accept rather than ignoring it.
 */

export type JsonObject = Record<string, unknown>;

/** The contract version this SDK implements. Named in the manifest's `service`. */
export const CONTRACT_VERSION = 1;

/* --- platform → automation ------------------------------------------------ */

/**
 * How a held or failed run is picked back up.
 *
 * `state` is this automation's own envelope, returned verbatim from the held run.
 * The platform never looked inside it.
 */
export interface Continuation {
  ofRunId: string;
  kind: 'approval' | 'retry';
  /** The declared step that held. Absent for a plain retry of a failed run. */
  stepId?: string;
  /** Present when `kind` is `approval`. */
  decision?: 'approved' | 'rejected';
  decidedAt?: string;
  state: JsonObject;
}

/** What the platform sends to start a run. Carries no credential — by design. */
export interface InvokeRequest {
  runId: string;
  templateId: string;
  templateVersion: number;
  /** Present so the automation can attribute work, never so it can query tenancy. */
  workspaceId: string;
  /** This subscription's setup values, validated by the platform against the manifest. */
  config: JsonObject;
  /** The trigger payload — the webhook body, the schedule tick, the manual input. */
  input: JsonObject;
  /** Present only when this run continues an earlier one. */
  continuation?: Continuation;
  callbackOrigin: string;
  /** Scoped to this run, expires with it. The only thing this automation may present. */
  runToken: string;
  deadline: string;
}

export type RefusalReason =
  'at-capacity' | 'draining' | 'unknown-template' | 'unsupported-contract-version';

/**
 * The answer to an invoke.
 *
 * An automation must be able to say no. Refusing is a real answer the platform
 * records — without it, backpressure has nothing to read and "at capacity" is
 * indistinguishable from "broken". The platform parses this strictly: a 2xx
 * status, a non-empty `runId`, and a reason it knows.
 */
export type InvokeAck =
  | { accepted: true; runId: string }
  | { accepted: false; runId: string; reason: RefusalReason; retryAfterSeconds?: number };

/* --- automation → platform ------------------------------------------------ */

export type StepOutcome = 'ok' | 'held' | 'failed';

/**
 * Progress on one step. `stepId` must exist in the manifest's pipeline.
 *
 * `runId` is REQUIRED by the platform's step handler, which compares it with the
 * token's run and refuses a mismatch.
 */
export interface StepReport {
  runId: string;
  stepId: string;
  outcome: StepOutcome;
  /** One line for the timeline, at most 200 characters. Never the payload itself. */
  summary: string;
  /** Required when the outcome is held: an approver needs something to decide on. */
  heldReason?: string;
}

/**
 * The final word on a run.
 *
 * `held` is terminal for THIS run, not a pause: the automation hands back
 * everything it needs to carry on and exits.
 */
export type RunResult =
  // `summary` is one line for a person reading a list of runs; `output` is the
  // structured result. The platform publishes the first and never the second.
  | { outcome: 'success'; output?: JsonObject; summary?: string }
  | { outcome: 'held'; held: { stepId: string; reason: string; state: JsonObject } }
  | { outcome: 'failed'; failureReason: string; retryState?: JsonObject };

/** Vendor-neutral capability an automation may request. Must be in the manifest. */
export type Capability = 'document-extraction' | 'classification' | 'screening' | 'summarization';

/** A model call the platform makes on the automation's behalf. The model is never named. */
export interface ModelRequest {
  capability: Capability;
  prompt: string;
  input: JsonObject;
  /** Honoured, not merely counted: an empty object means free text. */
  outputSchema: JsonObject;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** What the model callback answers. The text is the customer's data; keep it out of logs. */
export interface ModelCompletion {
  text: string;
  /** The model the provider actually served. */
  model: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  usage: ModelUsage;
}

/** A provider call the platform makes on the automation's behalf. */
export interface ProviderRequest {
  providerId: string;
  operation: string;
  input: JsonObject;
  /** Required, 16–128 characters: a retried step must not post the same invoice twice. */
  idempotencyKey: string;
}

/** The provider's own answer, so a 429 can be told from a 404. */
export interface ProviderAnswer {
  status: number;
  body: unknown;
}

/**
 * A file this run was given — the answer to the `artifact` callback.
 *
 * A reference and a short-lived link, never bytes. `downloadUrl` is the whole
 * permission, it expires with the run, and it was issued because the run token
 * proved which run was asking. There is deliberately no field a payload could
 * travel in.
 */
export interface ArtifactReference {
  artifactId: string;
  filename: string;
  contentType: string;
  /** As measured at the store, never as declared by whoever uploaded it. */
  sizeBytes: number;
  sha256?: string | null;
  downloadUrl: string;
  expiresAt: string;
}

/** A file named without a link — what the callback answers when no id is asked for. */
export type ArtifactListing = Omit<ArtifactReference, 'downloadUrl' | 'expiresAt'>;

/** The listing shape of a reference: the same facts, minus the link. */
export function toArtifactListing(reference: ArtifactReference): ArtifactListing {
  const { downloadUrl: _url, expiresAt: _expiry, ...listing } = reference;
  return listing;
}

/* --- one-line fields ------------------------------------------------------ */

/**
 * The bound on every one-line field an automation sends: a step's `summary` and
 * `heldReason`, a result's `summary`, `held.reason` and `failureReason`. The
 * platform's schema, its handler, and its column all name 200, and refuse longer.
 */
export const ONE_LINE_MAX_LENGTH = 200;

/**
 * Normalises a one-line field to what the wire accepts.
 *
 * Trimmed and cut at the bound rather than refused: a run whose work is done
 * must not become unreportable because a sentence ran to 201 characters — the
 * platform would answer 400, and a success with its side effects complete would
 * end as a deadline failure. An EMPTY line is refused here, because the platform
 * refuses it too and an author's own suite should be where that surfaces.
 */
export function oneLine(value: string, field: string): string {
  const line = value.trim().slice(0, ONE_LINE_MAX_LENGTH).trimEnd();
  if (line === '') throw new Error(`${field} must be a non-empty line`);
  return line;
}

/* --- guards --------------------------------------------------------------- */

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isContinuation(value: unknown): value is Continuation {
  if (!isObject(value)) return false;
  return (
    typeof value.ofRunId === 'string' &&
    (value.kind === 'approval' || value.kind === 'retry') &&
    (value.stepId === undefined || typeof value.stepId === 'string') &&
    (value.decision === undefined ||
      value.decision === 'approved' ||
      value.decision === 'rejected') &&
    (value.decidedAt === undefined || typeof value.decidedAt === 'string') &&
    isObject(value.state)
  );
}

export function isInvokeRequest(value: unknown): value is InvokeRequest {
  if (!isObject(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.templateId === 'string' &&
    typeof value.templateVersion === 'number' &&
    typeof value.workspaceId === 'string' &&
    isObject(value.config) &&
    isObject(value.input) &&
    (value.continuation === undefined || isContinuation(value.continuation)) &&
    typeof value.callbackOrigin === 'string' &&
    typeof value.runToken === 'string' &&
    typeof value.deadline === 'string'
  );
}

export function isArtifactListing(value: unknown): value is ArtifactListing {
  if (!isObject(value)) return false;
  return (
    typeof value.artifactId === 'string' &&
    typeof value.filename === 'string' &&
    typeof value.contentType === 'string' &&
    typeof value.sizeBytes === 'number'
  );
}

export function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isArtifactListing(value) &&
    typeof (value as JsonObject).downloadUrl === 'string' &&
    typeof (value as JsonObject).expiresAt === 'string'
  );
}

export function isModelCompletion(value: unknown): value is ModelCompletion {
  if (!isObject(value)) return false;
  const usage = value.usage;
  return (
    typeof value.text === 'string' &&
    typeof value.model === 'string' &&
    typeof value.finishReason === 'string' &&
    isObject(usage) &&
    typeof usage.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    typeof usage.totalTokens === 'number'
  );
}
