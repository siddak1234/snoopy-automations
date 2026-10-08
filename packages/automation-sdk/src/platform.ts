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
 * The platform refused a callback.
 *
 * Distinguished from a transport failure because the two mean different things to
 * the caller: a 422 is this automation reporting a step its manifest never declared
 * (fix the code), a 409 is a run that has already ended (stop), a 404 from the
 * artifact callback is a file this run was not given, and a timeout is the
 * platform being unreachable (the run's own deadline sweep will fail it).
 */
export class CallbackRefusedError extends Error {
  /** The platform's answer, cut to 200 characters for the message. */
  public readonly detail: string;
  /**
   * The platform's own `details.reason` when its problem body carried one —
   * `step_not_declared`, `provider_not_declared`, `recipient_inside_workspace` —
   * read from the whole answer, before the cut. Undefined when it sent none.
   */
  public readonly reason: string | undefined;

  public constructor(
    public readonly callback: string,
    public readonly status: number,
    answer: string,
  ) {
    const detail = answer.slice(0, 200);
    super(`callback ${callback} refused with ${status}: ${detail}`);
    this.name = 'CallbackRefusedError';
    this.detail = detail;
    this.reason = reasonOf(answer);
  }
}

/** The platform answers a refusal with `{ error: { details: { reason } } }`; anything else has none. */
function reasonOf(answer: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(answer);
    const error = isObject(parsed) ? parsed.error : undefined;
    const details = isObject(error) ? error.details : undefined;
    const reason = isObject(details) ? details.reason : undefined;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a failed `sendMail` CERTAINLY sent nothing.
 *
 * The platform reserves the send before the transport and KEEPS the reservation
 * when the transport is slow, and this client never retries — so an answer that
 * never came (a `TimeoutError`, a dropped connection, a 502 or 504 from the hop in
 * front of the platform) means the mail MAY have gone, and a person must not
 * re-send by hand. Certain are the platform's own refusals decided before the
 * transport: the two that name themselves (`recipient_inside_workspace` at 403,
 * `workspace_membership_truncated` at 502, which also releases the reservation), a
 * 503 (outbound mail is not configured: nothing was attempted), and any other 4xx
 * (refused on the way in — a malformed address, a spent allowance).
 */
export function mailCertainlyNotSent(error: unknown): boolean {
  if (!(error instanceof CallbackRefusedError)) return false;
  if (
    error.reason === 'recipient_inside_workspace' ||
    error.reason === 'workspace_membership_truncated'
  ) {
    return true;
  }
  if (error.status === 503) return true;
  return error.status < 500;
}

export interface PlatformClientOptions {
  /** Bound on the step, result, provider and artifact callbacks. Default 10 s. */
  timeoutMs?: number;
  /**
   * Bound on the model callback, which waits on a provider's generation and
   * cannot be held to the same ten seconds without making the capability
   * unusable. Default 60 s.
   */
  modelTimeoutMs?: number;
  /** Bound on fetching an artifact's bytes, which may be a scanned document. Default 60 s. */
  downloadTimeoutMs?: number;
  /**
   * Bound on the mail callback, which reserves the send, resolves the workspace's
   * members and calls the transport before it answers. Default 30 s. The hop in
   * front of the platform may give up sooner and answer 502: the platform KEEPS its
   * reservation on a slow transport and this client never retries, so a timeout
   * here means "unknown", not "not sent".
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
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#modelTimeoutMs = options.modelTimeoutMs ?? 60_000;
    this.#downloadTimeoutMs = options.downloadTimeoutMs ?? 60_000;
    this.#mailTimeoutMs = options.mailTimeoutMs ?? 30_000;
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
   * `detail` carries the platform's `details.reason` when the refusal was decided
   * before the transport (`recipient_inside_workspace`), which is how a caller
   * tells a certain failure from an answer that never came.
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
    const response = await fetch(artifact.downloadUrl, {
      signal: AbortSignal.timeout(this.#downloadTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`artifact ${artifact.artifactId} refused the link with ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async #post(message: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const response = await fetch(`${this.callbackOrigin}/v1/automations/callbacks/${message}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The run token, as a bearer credential. The platform relays it inward and
        // verifies it against the run it was minted for.
        authorization: `Bearer ${this.runToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Surfaced rather than swallowed. A refused callback means the platform
      // rejected something about this run — an undeclared step, an expired token —
      // and continuing as if it succeeded would produce a run whose timeline
      // disagrees with what actually happened.
      const answer = await response.text().catch(() => '');
      throw new CallbackRefusedError(message, response.status, answer);
    }

    // Parsed once here rather than per message, and an empty body is `undefined`
    // rather than a parse error.
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
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
