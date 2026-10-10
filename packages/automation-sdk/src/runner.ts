import type { InvokeRequest, JsonObject, RunResult } from './contract.js';
import type { Manifest } from './manifest.js';
import type { AutomationPlatform } from './platform.js';
import { renderPrompt, type PromptModule } from './prompt.js';
import { ModelRefusedError } from './refusals.js';
import {
  attempt,
  backoffWaits,
  boundedPolicy,
  retryableUnder,
  type RetryPolicy,
  withAttempts,
} from './retry.js';
import {
  type Automation,
  type AutomationDefinition,
  type ModelCallOptions,
  type StepContext,
  type StepPlatform,
  idempotencyKeyFor,
} from './steps.js';

/**
 * The step runner — the orchestrator of how an automation runs (platform ADR-0034).
 *
 * An automation is the manifest's declared pipeline, a function per step, and a
 * result. The runner runs the pipeline of the manifest VERSION the run pinned, in
 * order; reports each step through the step callback under the id the manifest
 * declares and no other; derives one idempotency key per run and step and attaches
 * it to every provider request and every mail; renders prompts by capability and
 * sends them to the models a step names, if any; re-attempts a step that declared a
 * retry policy when it fails transiently, with the same key, and reports it once
 * (`retry.ts`); and, when an approval continues a held run, resumes from
 * `continuation.state` at the step after the one that held (FR-15: a held run
 * ends; FR-17: an approval mints a continuation).
 *
 * The platform never learns the runner exists. It sees steps, results and
 * callbacks, exactly as it did when `execute()` was bare.
 */

/**
 * Builds the automation, and refuses one that does not conform.
 *
 * Checked here, once, at startup — a container that fails this never answers the
 * probe, which is louder than a 422 on the first run: every step a served manifest
 * declares is implemented; every implemented step is declared by a served
 * manifest; every prompt's capability is in EVERY served manifest's
 * `requiredCapabilities` (one container serves these versions and any of its runs
 * may reach the step that sends the prompt — platform D2 makes that one version
 * for everything new); no prompt or step id repeats; and every retry policy names
 * an implemented step, counts its attempts and its wait in whole numbers, and waits
 * at least `MIN_STEP_BACKOFF_MS` before a repeat.
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
  // A map, not an object: a step id is looked up, and an object would answer
  // `constructor` — a valid step id — from its prototype.
  const retries = new Map<string, RetryPolicy>();
  for (const [stepId, policy] of Object.entries(definition.retry ?? {})) {
    if (!Object.hasOwn(steps, stepId) || typeof steps[stepId] !== 'function') {
      throw new Error(`a retry policy names step "${stepId}", which the code does not implement`);
    }
    retries.set(stepId, boundedPolicy(stepId, policy));
  }

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
      // Every attempt runs with this one context, so with one key: a repeat reaches
      // the platform's record for the key rather than a fresh one. Reported ONCE,
      // after the last attempt, with the count when it took more than one.
      const policy = retries.get(stepId);
      const attempted = await attempt(
        () => step(context),
        policy ? backoffWaits(policy) : [],
        request.deadline,
        undefined,
        retryableUnder(policy),
      );
      const { attempts } = attempted;
      if (attempted.threw) {
        const { error } = attempted;
        // The timeline names the step the run died in. The summary is fixed text:
        // an error's message may embed the document, and serve() already turns the
        // message into the run's bounded failure reason. A model refusal the
        // platform typed adds its reason — one word from a closed list, never the
        // completion — so the timeline says why without the step catching it.
        await platform
          .reportStep({
            runId: request.runId,
            stepId,
            outcome: 'failed',
            summary: withAttempts(
              error instanceof ModelRefusedError
                ? `The ${stepId} step failed: the model call was refused (${error.reason})`
                : `The ${stepId} step failed`,
              attempts,
            ),
          })
          .catch(() => undefined);
        throw error;
      }
      const outcome = attempted.result;
      switch (outcome.outcome) {
        case 'skipped':
          continue;
        case 'ok':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'ok',
            summary: withAttempts(outcome.summary, attempts),
          });
          state = outcome.state ?? state;
          continue;
        case 'failed':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'failed',
            summary: withAttempts(outcome.summary, attempts),
          });
          if (outcome.failureReason !== undefined) return failed(outcome.failureReason);
          state = outcome.state ?? state;
          continue;
        case 'held':
          await platform.reportStep({
            runId: request.runId,
            stepId,
            outcome: 'held',
            summary: withAttempts(outcome.summary, attempts),
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
    retry: Object.fromEntries(retries),
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
    callModel(prompt, input, options) {
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
      const { models, artifactId } = Array.isArray(options)
        ? { models: options as readonly string[], artifactId: undefined }
        : ((options ?? {}) as ModelCallOptions);
      return platform.callModel({
        ...renderPrompt(module, input),
        ...(models === undefined ? {} : { models }),
        ...(artifactId === undefined ? {} : { artifactId }),
      });
    },
    callProvider: (request) => platform.callProvider({ ...request, idempotencyKey }),
    sendMail: (mail) => platform.sendMail({ ...mail, idempotencyKey }),
    readArtifact: (artifactId) => platform.readArtifact(artifactId),
    listArtifacts: () => platform.listArtifacts(),
    readArtifactBytes: (artifact) => platform.readArtifactBytes(artifact),
  };
}
