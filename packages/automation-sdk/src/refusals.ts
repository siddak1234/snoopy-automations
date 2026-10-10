import { isObject, type JsonObject } from './contract.js';

/**
 * The platform's refusals, read as the platform writes them.
 *
 * Every refusal the Runs service answers is an RFC 7807 problem — its
 * `createProblem` in `packages/http`: `{ type, title, status, detail, instance,
 * code, requestId, details? }` — and the Edge relays that body verbatim
 * (`apps/api/src/modules/automations/routes.ts`, `relayCallback`). `details.reason`
 * is the one word a caller branches on (`step_not_declared`,
 * `recipient_inside_workspace`, `output_schema_mismatch`, …); `detail` is a
 * sentence for a person. There is NO `error` wrapper. The first version of this
 * code read `error.details.reason`, a shape the platform never sends, so `reason`
 * was always undefined against the real platform and the one mail refusal told
 * apart by its reason alone — 502 `workspace_membership_truncated` — read as an
 * answer that never came. Found in review 2026-10-08.
 *
 * Read from the WHOLE answer, never from the 200-character cut kept for the
 * message: a real problem body puts `details` last, past that cut.
 */

interface Problem {
  code: string | undefined;
  details: JsonObject;
}

/** The problem in the answer. A body that is not one has no code and no details. */
export function problemOf(answer: string): Problem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return { code: undefined, details: {} };
  }
  if (!isObject(parsed)) return { code: undefined, details: {} };
  // The platform's problem is top-level. A `{ error: { … } }` wrapper is tolerated
  // for a hop that wraps what it relays — never required, never preferred.
  const problem = isObject(parsed.details) || !isObject(parsed.error) ? parsed : parsed.error;
  return {
    code: typeof problem.code === 'string' ? problem.code : undefined,
    details: isObject(problem.details) ? problem.details : {},
  };
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
  /** The problem's `code` — `BAD_REQUEST`, `FORBIDDEN`, `NOT_CONFIGURED`, … — when the answer was one. */
  public readonly code: string | undefined;
  /** The problem's `details`, read from the whole answer; `{}` when it carried none. */
  public readonly details: JsonObject;
  /**
   * The platform's own `details.reason` when its problem carried one —
   * `step_not_declared`, `provider_not_declared`, `recipient_inside_workspace`,
   * `workspace_membership_truncated` — read from the whole answer, before the cut.
   * Undefined when it sent none.
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
    const problem = problemOf(answer);
    this.code = problem.code;
    this.details = problem.details;
    this.reason = typeof problem.details.reason === 'string' ? problem.details.reason : undefined;
  }
}

/**
 * The reasons the platform's model callback refuses with (its `routes-model.ts`):
 * three 422s about the completion (`model-completion.ts`), three 403s about the
 * allowance (`model-allowance.ts`), and, since platform BUILD-PLAN 25.2.18, five about
 * the run's file (`model-file.ts`). A closed list, so a step branches on a word the
 * platform's tests pin, and anything else stays a plain `CallbackRefusedError`.
 */
export const MODEL_REFUSAL_REASONS = [
  /** 422: the completion is not the document `outputSchema` describes; `path` and `rule` say where and which keyword. */
  'output_schema_mismatch',
  /** 422: the vendor declined (SAFETY, RECITATION, PROHIBITED_CONTENT); permanent for that document. */
  'content_filtered',
  /** 422: the completion stopped at the output budget; retryable with a smaller prompt or document. */
  'truncated',
  /** 403: the plan's monthly allowance is spent; `used` and `limit`. Nothing was spent. */
  'over_plan_limit',
  /** 403: the plan grants no model calls at all; `used`. Nothing was spent. */
  'capability_not_in_plan',
  /** 403: the platform could not ask entitlements and refused rather than guess; `used`. Nothing was spent. */
  'entitlements_not_configured',
  /** 422: the pinned manifest takes no files, or not this type, or a model does not read it. Nothing was spent. */
  'content_type_not_accepted',
  /** 422: the file is larger than the manifest's bound or the platform's. Nothing was spent. */
  'file_too_large',
  /** 422: the file's leading bytes are not the type its upload declared. Nothing was spent. */
  'file_content_mismatch',
  /** 422: a password-protected PDF, which the models refuse. Nothing was spent. */
  'file_encrypted',
  /** 502: the store handed over a file unlike the one it measured. Nothing was spent. */
  'file_integrity',
] as const;

export type ModelRefusalReason = (typeof MODEL_REFUSAL_REASONS)[number];

export function isModelRefusalReason(value: unknown): value is ModelRefusalReason {
  return typeof value === 'string' && (MODEL_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The platform refused a model call with a typed problem — a word a step can
 * branch on, and NEVER the completion's text: the platform sends none with a
 * refusal (the completion restates the customer's document), and nothing here
 * would keep it if it did. `path` and `rule` name a place in the schema the
 * automation itself declared; `finishReason` is the vendor's, as the platform's
 * port maps it; `used` and `limit` are this month's count and the plan's ceiling.
 *
 * Still a `CallbackRefusedError` with `callback` `model`, so every branch written
 * for a refused callback keeps working; the message names the reason and where,
 * so a run that dies on it has a `failureReason` a person can read.
 */
export class ModelRefusedError extends CallbackRefusedError {
  declare public readonly reason: ModelRefusalReason;
  public readonly finishReason: string | undefined;
  public readonly path: string | undefined;
  public readonly rule: string | undefined;
  public readonly used: number | undefined;
  public readonly limit: number | undefined;

  /** The typed refusal when the answer's `details.reason` is one the model callback sends; undefined otherwise. */
  public static from(status: number, answer: string): ModelRefusedError | undefined {
    const reason = problemOf(answer).details.reason;
    return isModelRefusalReason(reason) ? new ModelRefusedError(status, answer, reason) : undefined;
  }

  private constructor(status: number, answer: string, reason: ModelRefusalReason) {
    super('model', status, answer);
    this.name = 'ModelRefusedError';
    const { details } = this;
    this.finishReason = text(details.finishReason);
    this.path = text(details.path);
    this.rule = text(details.rule);
    this.used = count(details.used);
    this.limit = count(details.limit);
    const where =
      this.path === undefined
        ? this.finishReason === undefined
          ? ''
          : ` (finish reason ${this.finishReason})`
        : ` at ${this.path}${this.rule === undefined ? '' : ` (${this.rule})`}`;
    const spent =
      this.used === undefined || this.limit === undefined
        ? ''
        : ` (${this.used} of ${this.limit} this month)`;
    this.message = `the model call was refused with ${status}: ${reason}${where}${spent}`;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * What the client throws for a refused callback: the typed model refusal when
 * the platform typed one, the plain refusal otherwise. One place, so a test
 * double built from the same answer throws the same error (`refusalFixture`).
 */
export function refusalFrom(
  callback: string,
  status: number,
  answer: string,
): CallbackRefusedError {
  return (
    (callback === 'model' ? ModelRefusedError.from(status, answer) : undefined) ??
    new CallbackRefusedError(callback, status, answer)
  );
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
