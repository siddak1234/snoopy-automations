/**
 * How the callback client marks a failure where the request is made — split from
 * `platform.ts`, whose client is what uses them, so neither passes the repository's
 * 400-line ceiling. The runner's step retry reads the marks (`retry.ts`).
 */

/**
 * The failures that are NO ANSWER AT ALL: `fetch` rejected — the connection was
 * refused, reset or never resolved, or the timeout fired — or the body was cut
 * off mid-read. Marked here, where the request is made, because nothing later can
 * tell them apart: Node rejects a refused connection and a cut body with the same
 * outer `TypeError` (measured on Node 22) — only its `cause` differs, which `unsent`
 * below reads.
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

/**
 * The codes Node's fetch puts on the error's `cause` when the connection failed
 * BEFORE a byte of the request was written: refused (`connect ECONNREFUSED`, or an
 * `AggregateError` with that code when every address of a name refused) and a name
 * that did not resolve, for good or for now (`ENOTFOUND`, `EAI_AGAIN`). Copied from
 * the platform's own split for its vendor calls (`UNSENT` in
 * `snoopy-backend/packages/model-gateway/src/http.ts`, its BUILD-PLAN 25.2.16).
 * Everything else may have reached the platform: a reset (`ECONNRESET` is the same
 * whether the request was read or not), a socket closed mid-answer, a timeout.
 */
const UNSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** The rejections that provably sent nothing: a subset of the unanswered ones. */
const unsentErrors = new WeakSet<object>();

/**
 * `pending` — a callback's `fetch`, never its body read — with a rejection that
 * provably sent nothing marked as such and passed on unchanged (BUILD-PLAN 25.3.13).
 * The cause is read for its code and nothing else.
 */
export function unsent<T>(pending: Promise<T>): Promise<T> {
  return pending.catch((error: unknown) => {
    const cause: unknown = error instanceof Error ? error.cause : undefined;
    const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
    if (typeof code === 'string' && UNSENT_CODES.has(code) && error instanceof Error) {
      unsentErrors.add(error);
    }
    throw error;
  });
}

/**
 * Whether this client threw `error` because a callback provably never left: the
 * connection was refused or the platform's name did not resolve. The one failure
 * a model call may be repeated on without the platform possibly having made the
 * first one — the owner's decision of 2026-10-10 (platform BUILD-PLAN 25.3.13).
 */
export function isUnsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && unsentErrors.has(error);
}
