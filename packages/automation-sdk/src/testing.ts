import { readFileSync } from 'node:fs';

import type {
  ArtifactListing,
  ArtifactReference,
  InvokeRequest,
  ModelCompletion,
  ModelRequest,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
  StepReport,
} from './contract.js';
import { oneLine, toArtifactListing } from './contract.js';
import { type AutomationPlatform, CallbackRefusedError, boundedResult } from './platform.js';

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
 * run was not given is a `CallbackRefusedError` with status 404.
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
  public artifactReads: string[] = [];

  /** Overridden per test. The default is a provider that says yes with nothing. */
  public provider: (call: ProviderRequest) => Promise<ProviderAnswer> = () =>
    Promise.resolve({ status: 200, body: {} });
  /** Overridden per test. The default is a model that answers an empty object. */
  public model: (call: ModelRequest) => Promise<ModelCompletion> = () =>
    Promise.resolve({
      text: '{}',
      model: 'test-model',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
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
    this.modelCalls.push(request);
    return this.model(request);
  }

  public callProvider(request: ProviderRequest): Promise<ProviderAnswer> {
    this.providerCalls.push(request);
    return this.provider(request);
  }

  public readArtifact(artifactId: string): Promise<ArtifactReference> {
    this.artifactReads.push(artifactId);
    const found = this.artifacts.find((artifact) => artifact.artifactId === artifactId);
    // Not found is what the platform answers for another run's file too: a
    // reference outside this run is indistinguishable from one that never existed.
    return found
      ? Promise.resolve(found)
      : Promise.reject(new CallbackRefusedError('artifact', 404, 'not found'));
  }

  public listArtifacts(): Promise<ArtifactListing[]> {
    return Promise.resolve(this.artifacts.map(toArtifactListing));
  }

  public readArtifactBytes(artifact: ArtifactReference): Promise<Uint8Array> {
    return Promise.resolve(this.bytes(artifact));
  }
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

/**
 * The step ids a manifest declares, READ FROM THE MANIFEST.
 *
 * The original template hand-copied them under a comment claiming they matched
 * the manifest — a claim nothing checked, which went stale the moment a version
 * added a step. An automation's suite asserts every step it can report is in this
 * set, so the refusal happens here rather than as a 422 in production.
 */
export function declaredSteps(manifestPath: string): Set<string> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    pipeline: { id: string }[];
  };
  return new Set(manifest.pipeline.map((step) => step.id));
}
