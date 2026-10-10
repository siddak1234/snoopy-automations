import type {
  ArtifactListing,
  ArtifactReference,
  InvokeRequest,
  JsonObject,
  MailRequest,
  ModelCompletion,
  ModelRequest,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
  StepReport,
} from './contract.js';
import { oneLine, toArtifactListing } from './contract.js';
import { readManifest } from './manifest.js';
import { artifactIdProblem, modelsProblem } from './model-request.js';
import { outputSchemaProblem, schemaMismatch, type SchemaMismatch } from './output-schema.js';
import { type AutomationPlatform, boundedResult } from './platform.js';
import { type CallbackRefusedError, refusalFrom } from './refusals.js';

/**
 * Test doubles for an automation's own suite.
 *
 * An automation is tested against a recording platform rather than a live one:
 * what matters in its suite is which steps it claims and what it hands back, and
 * both are decisions its code makes on its own. Whether the platform accepts them
 * is proven by the SDK's own tests against the wire, and end to end under Compose.
 *
 * The double behaves as the client does on the two things an author's code can
 * branch on: one-line fields are bounded and refused when empty, and a file this
 * run was not given is a `CallbackRefusedError` with status 404. It also refuses
 * the one mistake no branch answers, as the client does: a model request whose
 * `models` the platform would answer 400 is refused in the client's words before it
 * is recorded, so an author's own suite is where the mistake shows.
 *
 * **A model call is answered as the platform's callback answers it** (platform
 * BUILD-PLAN 25.2.3, 25.2.20, 25.2.22; SDK 25.3.10): a schema outside the platform's
 * keywords is its 400; then each model in the call's list — its `models`, else
 * `defaultModels` — is one attempt, `model` answering it; an answer the platform
 * could not use (filtered, truncated, empty, not the declared schema) and an attempt
 * that got no answer (`NO_ANSWER`) fall to the next model, in the platform's order;
 * and when none answers usably the call is the last refusal, typed as the platform
 * types it. An error `model` throws ends the call as thrown.
 *
 * Exported from `@autom8x/automation-sdk/testing` so no automation re-implements
 * the double — the one in the original template went stale the moment the wire
 * grew a message it did not know about.
 */

/** Records every call and answers from what the test configured. */
export class RecordingPlatform implements AutomationPlatform {
  public steps: StepReport[] = [];
  public results: { runId: string; result: RunResult }[] = [];
  public providerCalls: ProviderRequest[] = [];
  public modelCalls: ModelRequest[] = [];
  public mails: MailRequest[] = [];
  public artifactReads: string[] = [];

  /** Overridden per test. The default is a provider that says yes with nothing. */
  public provider: (call: ProviderRequest) => Promise<ProviderAnswer> = () =>
    Promise.resolve({ status: 200, body: {} });
  /** Overridden per test. The default is a platform that accepts every mail. */
  public mail: (mail: MailRequest) => Promise<void> = () => Promise.resolve();
  /**
   * Overridden per test: one attempt's answer, given the call and the model the attempt
   * asks. `NO_ANSWER` is an attempt that got none in time. The default answers an
   * empty object.
   */
  public model: (call: ModelRequest, model: string) => Promise<ModelCompletion | typeof NO_ANSWER> =
    (_call, model) =>
      Promise.resolve({
        text: '{}',
        model,
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
  /** What serves a call that names no models: the deployment's default list. */
  public defaultModels: readonly string[] = ['test-model'];
  /** Every attempt, as the platform's ledger would show it: the model and the outcome. */
  public modelAttempts: { model: string; outcome: ModelAttemptOutcome }[] = [];
  /** The files this run "was given". `readArtifact` answers from here or refuses. */
  public artifacts: ArtifactReference[] = [];
  /** The bytes behind a reference. */
  public bytes: (artifact: ArtifactReference) => Uint8Array = () => new Uint8Array();

  public reportStep(report: StepReport): Promise<void> {
    this.steps.push({
      ...report,
      summary: oneLine(report.summary, 'summary'),
      ...(report.heldReason === undefined
        ? {}
        : { heldReason: oneLine(report.heldReason, 'heldReason') }),
    });
    return Promise.resolve();
  }

  public reportResult(runId: string, result: RunResult): Promise<void> {
    this.results.push({ runId, result: boundedResult(result) });
    return Promise.resolve();
  }

  public callModel(request: ModelRequest): Promise<ModelCompletion> {
    const problem =
      (request.models === undefined ? undefined : modelsProblem(request.models)) ??
      (request.artifactId === undefined ? undefined : artifactIdProblem(request.artifactId));
    if (problem) return Promise.reject(new Error(problem));
    // A file this run was not given is the platform's 404, as the artifact callback's is
    // (platform BUILD-PLAN 25.2.18): its own, or its chain's first run's, and no other.
    const { artifactId } = request;
    if (artifactId !== undefined) {
      const given = this.artifacts.some(
        (artifact) => artifact.artifactId.toLowerCase() === artifactId.toLowerCase(),
      );
      if (!given) {
        return Promise.reject(
          refusalFixture('model', {
            status: 404,
            code: 'NOT_FOUND',
            detail: 'The requested resource was not found',
          }),
        );
      }
    }
    // The platform's 400 for a schema it cannot hold an answer to, before any attempt.
    const schemaProblem = outputSchemaProblem(request.outputSchema);
    if (schemaProblem) {
      return Promise.reject(
        refusalFixture('model', { status: 400, code: 'BAD_REQUEST', detail: schemaProblem }),
      );
    }
    this.modelCalls.push(request);
    return this.#attempt(request, [...(request.models ?? this.defaultModels)]);
  }

  /** One model per attempt, the next on an answer the platform could not use. */
  async #attempt(request: ModelRequest, models: string[]): Promise<ModelCompletion> {
    let last: CallbackRefusedError | undefined;
    for (const model of models) {
      const answer = await this.model(request, model);
      const refusal = unusable(answer, request.outputSchema);
      this.modelAttempts.push({ model, outcome: refusal ? refusal.outcome : 'ok' });
      if (!refusal) return answer as ModelCompletion;
      last = refusal.error;
    }
    throw last ?? new Error('the call named no model');
  }

  public callProvider(request: ProviderRequest): Promise<ProviderAnswer> {
    this.providerCalls.push(request);
    return this.provider(request);
  }

  public sendMail(mail: MailRequest): Promise<void> {
    this.mails.push(mail);
    return this.mail(mail);
  }

  public readArtifact(artifactId: string): Promise<ArtifactReference> {
    this.artifactReads.push(artifactId);
    const found = this.artifacts.find((artifact) => artifact.artifactId === artifactId);
    // Not found is what the platform answers for another run's file too: a
    // reference outside this run is indistinguishable from one that never existed.
    return found
      ? Promise.resolve(found)
      : Promise.reject(
          refusalFixture('artifact', {
            status: 404,
            code: 'NOT_FOUND',
            detail: 'The requested resource was not found',
          }),
        );
  }

  public listArtifacts(): Promise<ArtifactListing[]> {
    return Promise.resolve(this.artifacts.map(toArtifactListing));
  }

  public readArtifactBytes(artifact: ArtifactReference): Promise<Uint8Array> {
    return Promise.resolve(this.bytes(artifact));
  }
}

/** A scripted attempt that got no answer inside its time limit (platform BUILD-PLAN 25.2.22). */
export const NO_ANSWER: unique symbol = Symbol('no answer in time');

/** An attempt's outcome, as the platform's ledger names it. */
export type ModelAttemptOutcome = 'ok' | 'refused' | 'truncated' | 'unanswered';

/**
 * Why the platform would not hand this answer over, as it says it — its order, from
 * `model-completion.ts`: filtered, truncated, then (an empty answer) no completion,
 * then, for a declared schema, not JSON or not the schema's shape — or undefined.
 */
function unusable(
  answer: ModelCompletion | typeof NO_ANSWER,
  outputSchema: JsonObject,
): { outcome: ModelAttemptOutcome; error: CallbackRefusedError } | undefined {
  if (answer === NO_ANSWER) {
    const error = refusalFixture('model', {
      status: 502,
      code: 'DEPENDENCY_FAILURE',
      detail: 'The model provider is unreachable',
    });
    return { outcome: 'unanswered', error };
  }
  const refusal = (detail: string, reason: string, mismatch?: SchemaMismatch) =>
    refusalFixture('model', {
      status: 422,
      code: 'BAD_REQUEST',
      detail,
      details: { reason, finishReason: answer.finishReason, ...(mismatch ?? {}) },
    });
  if (answer.finishReason === 'content_filter') {
    const detail = 'The model provider declined to answer this request';
    return { outcome: 'refused', error: refusal(detail, 'content_filtered') };
  }
  if (answer.finishReason === 'length') {
    const detail = 'The model completion was truncated at the output budget';
    return { outcome: 'truncated', error: refusal(detail, 'truncated') };
  }
  if (answer.text.trim() === '') {
    const error = refusalFixture('model', {
      status: 502,
      code: 'DEPENDENCY_FAILURE',
      detail: 'The model provider returned no completion',
    });
    return { outcome: 'refused', error };
  }
  if (Object.keys(outputSchema).length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    const detail = 'The model completion is not the JSON document the request declared';
    return {
      outcome: 'refused',
      error: refusal(detail, 'output_schema_mismatch', { path: '$', rule: 'json' }),
    };
  }
  const mismatch = schemaMismatch(parsed, outputSchema);
  if (!mismatch) return undefined;
  const detail = 'The model completion does not match the request outputSchema';
  return { outcome: 'refused', error: refusal(detail, 'output_schema_mismatch', mismatch) };
}

/** A valid invoke, with fixture values an automation's tests can override. */
export function invokeFixture(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    runId: '11111111-1111-4111-8111-111111111111',
    templateId: 'fixture',
    templateVersion: 1,
    workspaceId: '22222222-2222-4222-8222-222222222222',
    config: {},
    input: {},
    callbackOrigin: 'http://platform.test',
    runToken: 'run-token-fixture',
    deadline: new Date(Date.now() + 900_000).toISOString(),
    ...overrides,
  };
}

/** A reference shaped exactly as the artifact callback answers. */
export function artifactFixture(overrides: Partial<ArtifactReference> = {}): ArtifactReference {
  return {
    artifactId: '33333333-3333-4333-8333-333333333333',
    filename: 'document.pdf',
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256: null,
    downloadUrl: 'http://store.test/objects/33333333-3333-4333-8333-333333333333?signature=fixture',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  };
}

/** A refusal as the platform's handlers raise it: a status, a code, a sentence, and the typed `details`. */
export interface ProblemInput {
  status: number;
  code: string;
  detail: string;
  details?: JsonObject;
  requestId?: string;
}

/** The problem codes the platform names and their titles — `titleFor` in its `packages/http`. */
const PROBLEM_TITLES: Readonly<Record<string, string>> = {
  BAD_REQUEST: 'Bad Request',
  PAYLOAD_TOO_LARGE: 'Payload Too Large',
  UNAUTHENTICATED: 'Authentication Required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not Found',
  CONFLICT: 'Conflict',
  NOT_CONFIGURED: 'Service Not Configured',
  TOO_MANY_REQUESTS: 'Too Many Requests',
  DEPENDENCY_FAILURE: 'Dependency Failure',
  INTERNAL_ERROR: 'Internal Server Error',
};

/**
 * A refusal body exactly as the platform's `createProblem` writes it and the Edge
 * relays it: RFC 7807, `details` at the top level, no `error` wrapper. Longer than
 * the 200 characters `CallbackRefusedError.detail` keeps — which is the point: a
 * fixture in this shape fails any reader that parses the cut instead of the body.
 */
export function problemFixture(input: ProblemInput): JsonObject {
  const requestId = input.requestId ?? '55555555-5555-4555-8555-555555555555';
  return {
    type: `urn:autom8x:problem:${input.code.toLowerCase().replaceAll('_', '-')}`,
    title: PROBLEM_TITLES[input.code] ?? input.code,
    status: input.status,
    detail: input.detail,
    instance: `urn:autom8x:request:${requestId}`,
    code: input.code,
    requestId,
    ...(input.details ? { details: input.details } : {}),
  };
}

/**
 * The error the client throws when `callback` answers this problem — built by the
 * same function the client uses, so a `ModelRefusedError` for a typed model
 * refusal and a `CallbackRefusedError` for anything else. Hand it to
 * `RecordingPlatform.mail`, `.model` or `.provider` to rehearse a refusal.
 */
export function refusalFixture(callback: string, problem: ProblemInput): CallbackRefusedError {
  return refusalFrom(callback, problem.status, JSON.stringify(problemFixture(problem)));
}

/**
 * The step ids a manifest declares, READ FROM THE MANIFEST.
 *
 * The original template hand-copied them under a comment claiming they matched
 * the manifest — a claim nothing checked, which went stale the moment a version
 * added a step. An automation's suite asserts every step it can report is in this
 * set, so the refusal happens here rather than as a 422 in production.
 */
export function declaredSteps(manifestPath: string): Set<string> {
  return new Set(readManifest(manifestPath).pipeline.map((step) => step.id));
}

/** The capabilities a manifest declares, READ FROM THE MANIFEST, for the same reason. */
export function declaredCapabilities(manifestPath: string): Set<string> {
  return new Set(readManifest(manifestPath).requiredCapabilities);
}
