import { createHash } from 'node:crypto';

import type {
  ArtifactListing,
  ArtifactReference,
  InvokeRequest,
  JsonObject,
  MailRequest,
  ModelCompletion,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
} from './contract.js';
import type { Manifest } from './manifest.js';
import type { AutomationPlatform } from './platform.js';
import type { PromptModule } from './prompt.js';
import type { RetryPolicy } from './retry.js';

/**
 * What an automation is made of — its steps, what each step may reach and decide,
 * and the definition the runner (`runner.ts`) builds from them. Split from the runner
 * so neither passes the repository's 400-line ceiling (`test/architecture.test.ts`).
 */

/**
 * What a model call names besides its prompt: its models, the primary then up to two
 * fallbacks (`ModelRequest.models`), and the run's own file (`ModelRequest.artifactId`,
 * platform BUILD-PLAN 25.2.18).
 */
export interface ModelCallOptions {
  models?: readonly string[];
  artifactId?: string;
}

/** What a step may reach. The run token travels with every call; no key or grant exists here. */
export interface StepPlatform {
  /**
   * Sends a REGISTERED prompt, rendered from `input`, by its capability — to the models
   * and with the file `options` names. A list alone is the models, as before.
   */
  callModel(
    prompt: PromptModule,
    input: JsonObject,
    options?: readonly string[] | ModelCallOptions,
  ): Promise<ModelCompletion>;
  /** A provider operation the manifest declared, with this step's idempotency key attached. */
  callProvider(request: Omit<ProviderRequest, 'idempotencyKey'>): Promise<ProviderAnswer>;
  /** A mail the platform sends from its own identity, with this step's idempotency key attached. */
  sendMail(mail: Omit<MailRequest, 'idempotencyKey'>): Promise<void>;
  readArtifact(artifactId: string): Promise<ArtifactReference>;
  listArtifacts(): Promise<ArtifactListing[]>;
  readArtifactBytes(artifact: ArtifactReference): Promise<Uint8Array>;
}

export interface StepContext {
  readonly request: InvokeRequest;
  readonly stepId: string;
  /** The automation's own envelope so far — `{}` on a first run, the continuation's state on a resumed one. */
  readonly state: JsonObject;
  /** `idempotencyKeyFor(runId, stepId)`: the one key this step's side effect carries. */
  readonly idempotencyKey: string;
  readonly platform: StepPlatform;
}

/**
 * What a step decides. Every variant but `skipped` is reported under the step's
 * id; `summary` is the one line the timeline keeps, so it never carries the
 * document. A `failed` step WITHOUT `failureReason` is visible and the run goes
 * on — a notice that could not be sent does not undo the work it describes.
 */
export type StepResult =
  | { outcome: 'ok'; summary: string; state?: JsonObject }
  | { outcome: 'skipped' }
  | { outcome: 'failed'; summary: string; failureReason?: string; state?: JsonObject }
  | { outcome: 'held'; summary: string; heldReason: string; reason: string; state: JsonObject };

export type Step = (context: StepContext) => Promise<StepResult>;

export interface AutomationDefinition {
  templateId: string;
  /** The versions this container serves, read from `manifests/` (`readManifests`). */
  manifests: readonly Manifest[];
  /** One function per declared step id. */
  steps: Readonly<Record<string, Step>>;
  /** Every prompt a step may send. Unregistered prompts are refused before the wire. */
  prompts?: readonly PromptModule[];
  /** The success result once the pipeline has run: the output and the one-line summary. */
  result: (state: JsonObject, request: InvokeRequest) => { output?: JsonObject; summary?: string };
  /**
   * The steps that are run again after a TRANSIENT failure, and how (`retry.ts`):
   * a step absent here runs once. Declare one only where a repeat is safe — a read;
   * mail with the same words, which the transport deduplicates under the step's key;
   * or a provider write at a vendor that deduplicates on `Idempotency-Key`. A provider
   * call that got no final answer has no record and is sent again, and a model call
   * has none at all: repeated, it is made and counted again.
   */
  retry?: Readonly<Record<string, RetryPolicy>>;
}

export interface Automation {
  readonly templateId: string;
  readonly versions: readonly number[];
  readonly steps: readonly string[];
  readonly prompts: readonly PromptModule[];
  /** Each declared retry policy as the runner applies it — clamped to the SDK's ceilings; one below its floor is refused. */
  readonly retry: Readonly<Record<string, RetryPolicy>>;
  /** What `serve()` runs. */
  execute(request: InvokeRequest, platform: AutomationPlatform): Promise<RunResult>;
}

/**
 * Packages a step's state for the continuation.
 *
 * The run ENDS here (FR-15). `summary` and `heldReason` go to the timeline, where
 * an approver reads them; `reason` is the result's line for the run list and
 * defaults to `heldReason`; `state` comes back verbatim in the continuation an
 * approval mints (FR-17), and the runner resumes at the next step with it.
 */
export function held(input: {
  summary: string;
  heldReason: string;
  reason?: string;
  state: JsonObject;
}): StepResult {
  return {
    outcome: 'held',
    summary: input.summary,
    heldReason: input.heldReason,
    reason: input.reason ?? input.heldReason,
    state: input.state,
  };
}

/**
 * One idempotency key per run and step: the step id, then 48 hex characters of
 * `sha256(runId, stepId)`. Identical on a re-run of the step — a re-dispatched
 * invoke carries the same run id — and different for every other step of the run,
 * so a step that posts never posts twice and two steps never share a key. Always
 * inside the platform's 16–128 bound and its character set, for any declared step
 * id (at most 64 characters) and any run id.
 */
export function idempotencyKeyFor(runId: string, stepId: string): string {
  const digest = createHash('sha256').update(`${runId}\n${stepId}`, 'utf8').digest('hex');
  return `${stepId}-${digest.slice(0, 48)}`;
}
