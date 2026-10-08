import type {
  ArtifactListing,
  ArtifactReference,
  InvokeRequest,
  MailRequest,
  ModelCompletion,
  ModelRequest,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
  StepReport,
} from './contract.js';
import {
  isArtifactListing,
  isArtifactReference,
  isMailAcceptance,
  isModelCompletion,
  isObject,
  oneLine,
} from './contract.js';
import { refusalFrom } from './refusals.js';

/**
 * The automation's only way to reach anything.
 *
 * Every callback presents the run token and nothing else. There is no other
 * credential in this process — no provider token, no model key, no database URL —
 * so if this client is the only outbound path, "the automation holds no
 * credentials" is a property of the code rather than a claim in a document.
 *
 * This is the piece the SDK exists to provide. Every automation re-implementing it
 * is where a credential eventually leaks, or where a step is reported that the
 * manifest never declared.
 */

/**
 * What an automation's `execute()` is handed. A test double implements the same.
 *
 * Six callbacks to the platform, each carrying the run token — step, result,
 * model, provider, artifact and mail; one listing that is the artifact callback
 * asked without an id; and one fetch that is NOT a callback and carries nothing —
 * the bytes behind a signed link.
 */
export interface AutomationPlatform {
  /** Reports progress on one declared step. */
  reportStep(report: StepReport): Promise<void>;
  /** The final outcome. After this the run has ended and the token is dead. */
  reportResult(runId: string, result: RunResult): Promise<void>;
  /** Asks the platform to make a model call this run's manifest declared a capability for. */
  callModel(request: ModelRequest): Promise<ModelCompletion>;
  /** Asks the platform to call a provider operation this run's manifest declared. */
  callProvider(request: ProviderRequest): Promise<ProviderAnswer>;
  /** Asks the platform to send one mail from its own identity — the only sender there is. */
  sendMail(mail: MailRequest): Promise<void>;
  /** A file this run was given, by reference and a short-lived link. */
  readArtifact(artifactId: string): Promise<ArtifactReference>;
  /** Every file this run was given, without links. */
  listArtifacts(): Promise<ArtifactListing[]>;
  /** The bytes a reference points at, fetched straight from the store. */
  readArtifactBytes(artifact: ArtifactReference): Promise<Uint8Array>;
}

/**
 * The client's default bounds. Each is longer than the platform takes to answer
 * the callbacks it bounds, so a step receives the platform's answer — recorded,
 * refused or failed — rather than this client's own timeout, which says only
 * "unknown". Read at snoopy-backend (platform BUILD-PLAN 25.2.13): the Edge relays a
 * callback for up to 55 s (5 s before 25.2.13); Runs waits up to 15 s on
 * Connections for a provider call, and Connections 10 s on the provider; the
 * gateway gives up on the model vendor at 45 s; mail waits on Access (5 s) and the
 * transport (10 s).
 */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 20_000;
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAIL_TIMEOUT_MS = 30_000;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface PlatformClientOptions {
  /**
   * Bound on the step, result, provider and artifact callbacks. Default 20 s,
   * longer than Runs waits on Connections for a provider call (15 s).
   */
  timeoutMs?: number;
  /**
   * Bound on the model callback, which waits on a provider's generation and
   * cannot be held to the same bound as the others without making the capability
   * unusable. Default 60 s, longer than the Edge relays a callback (55 s), which is
   * longer than the gateway waits on the vendor (45 s).
   */
  modelTimeoutMs?: number;
  /** Bound on fetching an artifact's bytes, which may be a scanned document. Default 60 s. */
  downloadTimeoutMs?: number;
  /**
   * Bound on the mail callback, which reserves the send, resolves the workspace's
   * members and calls the transport before it answers. Default 30 s. The platform
   * KEEPS its reservation on a slow transport and this client never retries, so a
   * timeout here means "unknown", not "not sent" — and so does a 502 from the hop in
   * front of the platform, which before platform BUILD-PLAN 25.2.13 gave up after 5 s.
   */
  mailTimeoutMs?: number;
}

export class PlatformClient implements AutomationPlatform {
  readonly #timeoutMs: number;
  readonly #modelTimeoutMs: number;
  readonly #downloadTimeoutMs: number;
  readonly #mailTimeoutMs: number;

  public constructor(
    private readonly callbackOrigin: string,
    private readonly runToken: string,
    options: PlatformClientOptions = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
    this.#modelTimeoutMs = options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.#mailTimeoutMs = options.mailTimeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS;
  }

  public async reportStep(report: StepReport): Promise<void> {
    // `runId` travels in the body: the platform compares it with the token's run
    // and refuses a mismatch, so a confused automation is told rather than humoured.
    await this.#post(
      'step',
      {
        ...report,
        summary: oneLine(report.summary, 'summary'),
        ...(report.heldReason === undefined
          ? {}
          : { heldReason: oneLine(report.heldReason, 'heldReason') }),
      },
      this.#timeoutMs,
    );
  }

  public async reportResult(runId: string, result: RunResult): Promise<void> {
    await this.#post('result', { runId, ...boundedResult(result) }, this.#timeoutMs);
  }

  /**
   * A model call the platform makes on this run's behalf.
   *
   * The model itself is not named here and cannot be: choosing one is choosing
   * what the platform spends per call, which is a deployment's decision. The
   * `capability` must appear in the manifest's `requiredCapabilities`; the
   * platform refuses one that does not before anything is sent to a vendor.
   * `outputSchema` is honoured, not merely counted — pass an empty object for
   * free text.
   *
   * A completion the platform will not hand over is a typed refusal, thrown as a
   * `ModelRefusedError`: 422 `output_schema_mismatch` (with `path` and `rule`),
   * `content_filtered` or `truncated` (each with the vendor's `finishReason`), and
   * 403 `over_plan_limit`, `capability_not_in_plan` or `entitlements_not_configured`
   * (with `used` and, when the plan has one, `limit`). Never the completion's text.
   */
  public async callModel(request: ModelRequest): Promise<ModelCompletion> {
    const answer = await this.#post('model', request, this.#modelTimeoutMs);
    const completion = isObject(answer) ? answer.model : undefined;
    if (!isModelCompletion(completion)) {
      throw new Error('the model callback did not answer with a completion');
    }
    return completion;
  }

  /**
   * Calls a provider operation the manifest declared.
   *
   * No provider token exists in this process to attach. The automation names a
   * PROVIDER and an OPERATION; the platform resolves which connection that
   * workspace has, attaches its grant, and discards it. Neither the workspace nor
   * the connection id is sent — both come from the run token, because a container
   * able to name either could aim an authenticated call at an account this
   * workspace never connected.
   *
   * `idempotencyKey` is required and bounded at 16–128 characters by the platform:
   * a retried step must not send the same mail twice, and the far end refuses a
   * key outside that range.
   *
   * The provider's own status comes back nested, so a 429 can be told from a 404.
   * Returned rather than thrown — the CALLBACK succeeded, and only the caller knows
   * whether the provider's answer is fatal to what it was doing.
   */
  public async callProvider(request: ProviderRequest): Promise<ProviderAnswer> {
    const answer = await this.#post('provider', request, this.#timeoutMs);
    const provider = isObject(answer) ? answer.provider : undefined;
    if (!isObject(provider) || typeof provider.status !== 'number') {
      throw new Error('the provider callback did not answer with a status');
    }
    return { status: provider.status, body: provider.body };
  }

  /**
   * Asks the PLATFORM to send one mail, from its own identity, to one address.
   *
   * The sixth callback (platform ADR-0021: the platform is the only sender). This
   * process names no mailbox and holds no grant; the platform applies the
   * self-send refusal, the per-run and per-workspace caps, and the sending
   * address. Exactly the four fields its handler allow-lists are sent. A refusal
   * surfaces as a `CallbackRefusedError`, as every other callback's does — its
   * `reason` is the platform's `details.reason` when the refusal was decided
   * before the transport (`recipient_inside_workspace`,
   * `workspace_membership_truncated`), which is how `mailCertainlyNotSent` tells
   * a certain failure from an answer that never came.
   */
  public async sendMail(mail: MailRequest): Promise<void> {
    const answer = await this.#post(
      'mail',
      {
        to: mail.to,
        subject: mail.subject,
        body: mail.body,
        idempotencyKey: mail.idempotencyKey,
      },
      this.#mailTimeoutMs,
    );
    if (!isMailAcceptance(answer)) {
      throw new Error('the mail callback did not answer with an acceptance');
    }
  }

  /**
   * Reads a file this run was given.
   *
   * The automation names an artifact; the platform decides whether THIS run may
   * have it, from the token alone. What comes back is a reference and a signed URL
   * that expires with the run. No store credential exists in this process to hold.
   */
  public async readArtifact(artifactId: string): Promise<ArtifactReference> {
    const answer = await this.#post('artifact', { artifactId }, this.#timeoutMs);
    const artifact = isObject(answer) ? answer.artifact : undefined;
    if (!isArtifactReference(artifact)) {
      throw new Error('the artifact callback did not answer with a reference');
    }
    return artifact;
  }

  /** The same callback with no id names every file of this run, without links. */
  public async listArtifacts(): Promise<ArtifactListing[]> {
    const answer = await this.#post('artifact', {}, this.#timeoutMs);
    const artifacts = isObject(answer) ? answer.artifacts : undefined;
    if (!Array.isArray(artifacts) || !artifacts.every(isArtifactListing)) {
      throw new Error('the artifact callback did not answer with a listing');
    }
    return artifacts;
  }

  /**
   * Fetches the bytes the signed URL points at.
   *
   * The one outbound request that is not a callback, and the one that presents no
   * credential at all — not even the run token. The link is the whole permission,
   * which is why bytes never traverse the platform's public service.
   */
  public async readArtifactBytes(artifact: ArtifactReference): Promise<Uint8Array> {
    const response = await unanswered(
      fetch(artifact.downloadUrl, { signal: AbortSignal.timeout(this.#downloadTimeoutMs) }),
    );
    if (!response.ok) {
      throw new Error(`artifact ${artifact.artifactId} refused the link with ${response.status}`);
    }
    return new Uint8Array(await unanswered(response.arrayBuffer()));
  }

  async #post(message: string, body: unknown, timeoutMs: number): Promise<unknown> {
    // Serialised BEFORE the request, outside the mark: an input JSON cannot carry
    // throws here, a step's own fault, and must never read as an answer that did not come.
    const payload = JSON.stringify(body);
    const response = await unanswered(
      fetch(`${this.callbackOrigin}/v1/automations/callbacks/${message}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The run token, as a bearer credential. The platform relays it inward and
          // verifies it against the run it was minted for.
          authorization: `Bearer ${this.runToken}`,
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );

    if (!response.ok) {
      // Surfaced rather than swallowed. A refused callback means the platform
      // rejected something about this run — an undeclared step, an expired token —
      // and continuing as if it succeeded would produce a run whose timeline
      // disagrees with what actually happened.
      const answer = await response.text().catch(() => '');
      // The platform's problem body, read whole (`refusals.ts`): a model
      // refusal the platform typed is a `ModelRefusedError`, anything else a
      // `CallbackRefusedError` with the problem's `code`, `details` and `reason`.
      throw refusalFrom(message, response.status, answer);
    }

    // Parsed once here rather than per message, and an empty body is `undefined`
    // rather than a parse error. A body cut off mid-read is no answer either; one
    // that arrived whole and does not parse IS an answer, and is not marked.
    const text = await unanswered(response.text());
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
}

/**
 * The failures that are NO ANSWER AT ALL: `fetch` rejected — the connection was
 * refused, reset or never resolved, or the timeout fired — or the body was cut
 * off mid-read. Marked here, where the request is made, because nothing later can
 * tell them apart: Node rejects a refused connection, a cut body and an input
 * `JSON.stringify` cannot carry with the same `TypeError` (measured on Node 22).
 * The runner's step retry reads the mark (`retry.ts`); a refusal the platform
 * answered, an answer that does not parse, and a step's own error are never marked.
 * A set of the error objects themselves, so nothing is wrapped: a `TimeoutError`
 * stays one, and its message stays the run's `failureReason`.
 */
const unansweredErrors = new WeakSet<object>();

/** `pending`, with its rejection marked as an answer that never came, and passed on unchanged. */
export function unanswered<T>(pending: Promise<T>): Promise<T> {
  return pending.catch((error: unknown) => {
    if (typeof error === 'object' && error !== null) unansweredErrors.add(error);
    throw error;
  });
}

/** Whether this client threw `error` because no answer came. */
export function isUnanswered(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unansweredErrors.has(error);
}

/** The result with every one-line field normalised to what the wire accepts. */
export function boundedResult(result: RunResult): RunResult {
  switch (result.outcome) {
    case 'success':
      return result.summary === undefined
        ? result
        : { ...result, summary: oneLine(result.summary, 'summary') };
    case 'held':
      return {
        ...result,
        held: { ...result.held, reason: oneLine(result.held.reason, 'held.reason') },
      };
    case 'failed':
      return { ...result, failureReason: oneLine(result.failureReason, 'failureReason') };
  }
}

/** Builds the client for one invoke. */
export function clientFor(request: InvokeRequest, options?: PlatformClientOptions): PlatformClient {
  return new PlatformClient(request.callbackOrigin, request.runToken, options);
}
