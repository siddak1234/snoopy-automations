import { createHash } from 'node:crypto';

import type {
  ArtifactListing,
  ArtifactReference,
  InvokeRequest,
  JsonObject,
  MailContent,
  ModelCompletion,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
} from './contract.js';
import type { RunDetail } from './details.js';
import type { RunDocument } from './documents.js';
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
 * fallbacks (`ModelRequest.models`), the makers it leaves out
 * (`ModelRequest.excludeModelAuthors`, platform BUILD-PLAN 25.2.29), and the run's own
 * file (`ModelRequest.artifactId`, platform BUILD-PLAN 25.2.18).
 */
export interface ModelCallOptions {
  models?: readonly string[];
  excludeModelAuthors?: readonly string[];
  artifactId?: string;
}

/**
 * How one side effect of a step is keyed. A step has ONE idempotency key (`idempotencyKeyFor`), and
 * the platform answers a second call under a key from the first's record — so a step that does
 * several things, one per document, names a `part` for each: `^[a-z0-9-]{1,12}$`, the same part on
 * every attempt for the same thing (platform BUILD-PLAN 25.4.31; the session's spec, S17).
 */
export interface CallOptions {
  part?: string;
}

/** A part's name: lowercase letters, digits and hyphens, 1 to 12 of them. */
export const PART_PATTERN = /^[a-z0-9-]{1,12}$/u;

/**
 * The key of one part of a step: `<step key>.<part>` — at most 113 + 1 + 12 = 126 characters, in
 * the platform's 16–128 bound and its character set (`A-Z a-z 0-9 . _ ~ : -`) — or the step's own
 * key when no part is named. A part outside `PART_PATTERN` is the caller's mistake, refused before
 * anything is sent.
 */
export function partKey(idempotencyKey: string, part: string | undefined): string {
  if (part === undefined) return idempotencyKey;
  if (!PART_PATTERN.test(part)) {
    throw new Error(
      `part ${JSON.stringify(part)} must be 1-12 lowercase letters, digits or hyphens`,
    );
  }
  return `${idempotencyKey}.${part}`;
}

/** What a step may reach. The run token travels with every call; no key or grant exists here. */
export interface StepPlatform {
  /**
   * Sends a REGISTERED prompt, rendered from `input`, by its capability — to the models,
   * less the makers, and with the file `options` names. A list alone is the models, as before.
   */
  callModel(
    prompt: PromptModule,
    input: JsonObject,
    options?: readonly string[] | ModelCallOptions,
  ): Promise<ModelCompletion>;
  /**
   * A provider operation the manifest declared, with this step's idempotency key attached — or,
   * with `part`, the key of that part of the step (`partKey`).
   */
  callProvider(
    request: Omit<ProviderRequest, 'idempotencyKey'>,
    options?: CallOptions,
  ): Promise<ProviderAnswer>;
  /** A mail the platform sends from its own identity, keyed as `callProvider` keys a call. */
  sendMail(mail: MailContent, options?: CallOptions): Promise<void>;
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
  | {
      outcome: 'held';
      summary: string;
      heldReason: string;
      reason: string;
      state: JsonObject;
      /** The documents read so far, as the held result shows them (platform ADR-0039). */
      documents?: readonly RunDocument[];
    };

export type Step = (context: StepContext) => Promise<StepResult>;

export interface AutomationDefinition {
  templateId: string;
  /** The versions this container serves, read from `manifests/` (`readManifests`). */
  manifests: readonly Manifest[];
  /** One function per declared step id. */
  steps: Readonly<Record<string, Step>>;
  /** Every prompt a step may send. Unregistered prompts are refused before the wire. */
  prompts?: readonly PromptModule[];
  /**
   * The success result once the pipeline has run: the output, the one-line summary, the
   * `details` a person reads beside it (platform ADR-0037), and the `documents` the run read
   * (platform ADR-0039), which the client bounds.
   */
  result: (
    state: JsonObject,
    request: InvokeRequest,
  ) => {
    output?: JsonObject;
    summary?: string;
    details?: readonly RunDetail[];
    documents?: readonly RunDocument[];
  };
  /**
   * The steps that are run again after a TRANSIENT failure, and how (`retry.ts`):
   * a step absent here runs once. Declare one only where a repeat is safe — a read;
   * mail with the same words, which the transport deduplicates under the step's key;
   * or a provider write at a vendor that deduplicates on `Idempotency-Key`. A provider
   * call that got no final answer has no record and is sent again, and a model call
   * has none at all: repeated, it is made and counted again.
   */
  retry?: Readonly<Record<string, RetryPolicy>>;
  /**
   * A step that THREW, once its attempts are spent (`retry`): the result the automation ends it
   * with instead, or `undefined` to let the throw end the run as before. The runner reports the
   * result under the step's id and goes on exactly as if the step had returned it — so an
   * automation that can do without a provider (an optional connection, platform ADR-0037) says
   * so once here, and never sooner than the SDK's retry has given up.
   */
  recover?: (stepId: string, error: unknown, context: StepContext) => StepResult | undefined;
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
  documents?: readonly RunDocument[];
}): StepResult {
  return {
    outcome: 'held',
    summary: input.summary,
    heldReason: input.heldReason,
    reason: input.reason ?? input.heldReason,
    state: input.state,
    ...(input.documents === undefined ? {} : { documents: input.documents }),
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
