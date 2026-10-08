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
import { renderPrompt, type PromptModule } from './prompt.js';

/**
 * The step runner — the orchestrator of how an automation runs (platform ADR-0034).
 *
 * An automation is the manifest's declared pipeline, a function per step, and a
 * result. The runner runs the pipeline of the manifest VERSION the run pinned, in
 * order; reports each step through the step callback under the id the manifest
 * declares and no other; derives one idempotency key per run and step and attaches
 * it to every provider request and every mail; renders prompts by capability and
 * never by model; and, when an approval continues a held run, resumes from
 * `continuation.state` at the step after the one that held (FR-15: a held run ends;
 * FR-17: an approval mints a continuation).
 *
 * The platform never learns the runner exists. It sees steps, results and
 * callbacks, exactly as it did when `execute()` was bare.
 */

/** What a step may reach. The run token travels with every call; no key or grant exists here. */
export interface StepPlatform {
  /** Sends a REGISTERED prompt, rendered from `input`, by its capability. */
  callModel(prompt: PromptModule, input: JsonObject): Promise<ModelCompletion>;
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
}

export interface Automation {
  readonly templateId: string;
  readonly versions: readonly number[];
  readonly steps: readonly string[];
  readonly prompts: readonly PromptModule[];
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

/**
 * Builds the automation, and refuses one that does not conform.
 *
 * Checked here, once, at startup — a container that fails this never answers the
 * probe, which is louder than a 422 on the first run: every step a served manifest
 * declares is implemented; every implemented step is declared by a served
 * manifest; every prompt's capability is in EVERY served manifest's
 * `requiredCapabilities` (one container serves these versions and any of its runs
 * may reach the step that sends the prompt — platform D2 makes that one version
 * for everything new); and no prompt or step id repeats.
 */
export function defineAutomation(definition: AutomationDefinition): Automation {
  const { templateId, manifests, steps, result } = definition;
  const prompts = definition.prompts ?? [];
  if (manifests.length === 0) throw new Error(`${templateId} serves no manifest version`);

  const byVersion = new Map<number, Manifest>();
  const declared = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.templateId !== templateId) {
      throw new Error(`${templateId} cannot serve a manifest for ${manifest.templateId}`);
    }
    if (byVersion.has(manifest.version)) {
      throw new Error(`${templateId} v${manifest.version} is served twice`);
    }
    byVersion.set(manifest.version, manifest);
    const ids = new Set<string>();
    for (const step of manifest.pipeline) {
      if (ids.has(step.id)) {
        throw new Error(`${templateId} v${manifest.version} declares step "${step.id}" twice`);
      }
      ids.add(step.id);
      declared.add(step.id);
      if (typeof steps[step.id] !== 'function') {
        throw new Error(
          `${templateId} v${manifest.version} declares step "${step.id}", which the code does not implement`,
        );
      }
    }
    for (const prompt of prompts) {
      if (!manifest.requiredCapabilities.includes(prompt.capability)) {
        throw new Error(
          `prompt ${prompt.id} v${prompt.version} uses ${prompt.capability}, which ${templateId} v${manifest.version} does not declare in requiredCapabilities`,
        );
      }
    }
  }
  for (const stepId of Object.keys(steps)) {
    if (!declared.has(stepId)) {
      throw new Error(
        `step "${stepId}" is not declared by any manifest ${templateId} serves — the platform would refuse it`,
      );
    }
  }
  const registered = new Map<string, PromptModule>();
  for (const prompt of prompts) {
    const key = `${prompt.id}@${prompt.version}`;
    if (registered.has(key)) throw new Error(`prompt ${key} is registered twice`);
    registered.set(key, prompt);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);

  async function execute(request: InvokeRequest, platform: AutomationPlatform): Promise<RunResult> {
    if (request.templateId !== templateId) {
      return failed(`this automation is ${templateId}, not ${request.templateId}`);
    }
    const manifest = byVersion.get(request.templateVersion);
    if (!manifest) {
      return failed(
        `this container serves ${templateId} v${versions.join(', v')}, not v${request.templateVersion}`,
      );
    }
    const pipeline = manifest.pipeline.map((step) => step.id);

    let state: JsonObject = {};
    let from = 0;
    const continuation = request.continuation;
    if (continuation) {
      // The platform mints a continuation only for an approval (a rejection ends
      // the work); checked anyway, because posting what nobody approved is the
      // one thing this path must never do.
      if (continuation.decision !== 'approved') {
        return failed('the approval continuation was not approved');
      }
      if (continuation.stepId === undefined) {
        return failed('the continuation names no step to resume from');
      }
      const at = pipeline.indexOf(continuation.stepId);
      if (at < 0) {
        return failed(
          `the continuation resumes at "${continuation.stepId}", which ${templateId} v${manifest.version} does not declare`,
        );
      }
      from = at + 1;
      state = continuation.state;
    }

    for (const stepId of pipeline.slice(from)) {
      const step = steps[stepId];
      if (!step) return failed(`step "${stepId}" is declared and not implemented`);
      const idempotencyKey = idempotencyKeyFor(request.runId, stepId);
      const context: StepContext = {
        request,
        stepId,
        state,
        idempotencyKey,
        platform: stepPlatform(platform, manifest, registered, idempotencyKey),
      };
      let outcome: StepResult;
      try {
        outcome = await step(context);
      } catch (error) {
        // The timeline names the step the run died in. The summary is fixed text:
        // an error's message may embed the document, and serve() already turns the
        // message into the run's bounded failure reason.
        await platform
          .reportStep({
            runId: request.runId,
            stepId,
            outcome: 'failed',
            summary: `The ${stepId} step failed`,
          })
          .catch(() => undefined);
        throw error;
      }
      switch (outcome.outcome) {
        case 'skipped':
          continue;
        case 'ok':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'ok',
            summary: outcome.summary,
          });
          state = outcome.state ?? state;
          continue;
        case 'failed':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'failed',
            summary: outcome.summary,
          });
          if (outcome.failureReason !== undefined) return failed(outcome.failureReason);
          state = outcome.state ?? state;
          continue;
        case 'held':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'held',
            summary: outcome.summary,
            heldReason: outcome.heldReason,
          });
          return {
            outcome: 'held',
            held: { stepId, reason: outcome.reason, state: outcome.state },
          };
      }
    }

    const { output, summary } = result(state, request);
    return {
      outcome: 'success',
      ...(output === undefined ? {} : { output }),
      ...(summary === undefined ? {} : { summary }),
    };
  }

  return {
    templateId,
    versions,
    steps: Object.keys(steps),
    prompts,
    execute,
  };
}

function failed(failureReason: string): RunResult {
  return { outcome: 'failed', failureReason };
}

/**
 * The platform as one step sees it: the same callbacks, with this step's key on
 * every side effect, prompts rendered by capability, and nothing that reports —
 * the runner reports, under the declared id, and nothing else can.
 */
function stepPlatform(
  platform: AutomationPlatform,
  manifest: Manifest,
  registered: ReadonlyMap<string, PromptModule>,
  idempotencyKey: string,
): StepPlatform {
  return {
    callModel(prompt, input) {
      const module = registered.get(`${prompt.id}@${prompt.version}`);
      if (!module) {
        throw new Error(
          `prompt ${prompt.id} v${prompt.version} is not registered with this automation`,
        );
      }
      // The REGISTERED module is what is rendered and sent — the one the
      // conformance checks saw — even if the caller's copy differs in its text.
      // Refused here, before anything is sent: the platform would refuse it too,
      // after the request had travelled.
      if (!manifest.requiredCapabilities.includes(module.capability)) {
        throw new Error(
          `prompt ${module.id} v${module.version} uses ${module.capability}, which ${manifest.templateId} v${manifest.version} does not declare`,
        );
      }
      return platform.callModel(renderPrompt(module, input));
    },
    callProvider: (request) => platform.callProvider({ ...request, idempotencyKey }),
    sendMail: (mail) => platform.sendMail({ ...mail, idempotencyKey }),
    readArtifact: (artifactId) => platform.readArtifact(artifactId),
    listArtifacts: () => platform.listArtifacts(),
    readArtifactBytes: (artifact) => platform.readArtifactBytes(artifact),
  };
}
