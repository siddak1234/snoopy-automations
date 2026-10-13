import type { JsonObject, ProviderAnswer, StepPlatform } from '@autom8x/automation-sdk';

import { entityOf, faultOf } from './answers.js';
import { refusalOf } from './read.js';

/**
 * One QuickBooks WRITE through the SDK's provider call — a bill, an expense, a vendor
 * credit, a journal entry or a vendor — judged so that a step never makes a second record:
 *
 * **Repeated only by the step's retry, and only when nothing answered.** One request a
 * call: no wait after QuickBooks' 429, no second try after its 5xx. A failure no answer
 * judged — no answer at all, or a 502, 503 or 504 naming no reason, as the platform
 * answers when a hop or a dependency did not — is THROWN UNCHANGED, the same object, so a
 * step that declares a retry has the SDK send the same request under its one key again:
 * Connections replays a final answer it recorded, and otherwise asks Intuit again under the
 * same `requestid`, which the PLATFORM derives from the step's key and puts on the URL (its
 * BUILD-PLAN 25.2.26) — and Intuit answers a repeated `requestid` with its first answer,
 * the same record and Id, never a second record: for a bill, an expense, a vendor credit, a
 * journal entry and a vendor, with the body changed, two copies in flight, and 75 minutes
 * later (sandbox S6, 2026-10-12). So the input never carries a `requestid` — one in it is
 * the caller's mistake, refused before anything is sent — and the step registers its own
 * "did not confirm" sentence on what is thrown, for when the attempts are spent.
 *
 * **Did it happen?** Each answer says whether a record may exist. Certain — refused
 * before QuickBooks, or refused by QuickBooks with a Fault or a 4xx — says no record was
 * created. Uncertain — a 5xx, 408, 425 or 429 from QuickBooks, Intuit's Fault 600 (a
 * repeated request id), a 409 for another body under the key, a 2xx without the record's
 * Id, a refusal this code does not know — says QuickBooks did not confirm it, in a fixed
 * sentence that sends the person to check QuickBooks before running it again.
 *
 * **Certain only while nothing went unanswered.** Once an attempt of a step's write was
 * thrown on unanswered, that attempt may have made the record — Intuit acting while the
 * answer was lost — so no later attempt's answer can say none was made: a refusal of the
 * repeat (no live connection any more, the Edge's flood valve with no time left to wait, a
 * 400, a 403 at the deadline) or QuickBooks refusing it says QuickBooks did not confirm it
 * instead, `detail` naming what the repeat was answered (Gate 25's AUT-38-1). The attempts
 * of a step share one platform object — the SDK's runner hands every attempt its one
 * context (`packages/automation-sdk/src/runner.ts`) — so the write notes, against that
 * object, an attempt it threw on; a step's first answer is judged as it always was.
 *
 * A Fault is named by its number alone, in `detail`: the caller maps the codes it knows
 * (Group 5's 6140, 6210, …) to its own sentences. Intuit's `Message` and `Detail` are
 * never read.
 */

/** The records a step may create, the operation the platform declares for each, and its noun. */
export const QUICKBOOKS_WRITES = {
  bill: { operation: 'bill.create', entity: 'Bill', noun: 'bill' },
  expense: { operation: 'purchase.create', entity: 'Purchase', noun: 'expense' },
  vendorCredit: { operation: 'vendorCredit.create', entity: 'VendorCredit', noun: 'vendor credit' },
  journalEntry: {
    operation: 'journalEntry.create',
    entity: 'JournalEntry',
    noun: 'journal entry',
  },
  /** A new vendor a bill names: created only after an approval, before the bill. */
  vendor: { operation: 'vendor.create', entity: 'Vendor', noun: 'vendor' },
} as const;
export type QuickBooksWriteKind = keyof typeof QUICKBOOKS_WRITES;

/** How a write can fail, each with its sentence. */
export type QuickBooksWriteFailure =
  | 'qb_not_connected'
  | 'qb_reauthorize'
  | 'qb_forbidden'
  | 'qb_missing_scope'
  | 'qb_not_configured'
  | 'platform_busy'
  | 'platform_refused'
  | 'qb_refused'
  | 'qb_unconfirmed';

/** The fixed sentences for one record, each at most 200 characters, never Intuit's words. */
export function writeSentences(noun: string): Readonly<Record<QuickBooksWriteFailure, string>> {
  const none = `no ${noun} was created`;
  return {
    qb_not_connected: `Reconnect QuickBooks in Connections, then run it again. No ${noun} was created.`,
    qb_reauthorize: `Reconnect QuickBooks in Connections, then run it again. No ${noun} was created.`,
    qb_forbidden: `QuickBooks refused access to this company, so ${none}. Reconnect QuickBooks in Connections as a company admin, then run it again.`,
    qb_missing_scope: `QuickBooks was connected without accounting access, so ${none}. Reconnect QuickBooks in Connections, then run it again.`,
    qb_not_configured: `QuickBooks calls are not available on Autom8x right now, so ${none}. Run it again later.`,
    platform_busy: `Autom8x is busy, so ${none}. Run it again in a few minutes.`,
    platform_refused: `Autom8x could not send the ${noun} to QuickBooks, so ${none}.`,
    qb_refused: `QuickBooks refused the ${noun}, so ${none}.`,
    qb_unconfirmed: `QuickBooks did not confirm whether the ${noun} was created. Check QuickBooks before running this again.`,
  };
}

export interface QuickBooksWriteRequest {
  /** The step's platform: the runner attaches the step's one key to the call. */
  readonly platform: Pick<StepPlatform, 'callProvider'>;
  readonly kind: QuickBooksWriteKind;
  /** The record's body, sent as it is; built from the run's state alone, so every copy is the same bytes. */
  readonly input: JsonObject;
}

/** The created record and its Id, or the failure with its sentence and whether a record may exist. */
export type QuickBooksWrite =
  | { readonly ok: true; readonly id: string; readonly record: JsonObject }
  | {
      readonly ok: false;
      readonly reason: QuickBooksWriteFailure;
      /** `false`: certainly not created. `'unknown'`: QuickBooks may have created it. */
      readonly created: false | 'unknown';
      readonly sentence: string;
      /**
       * The Fault code, QuickBooks' status, or the platform's reason word — or, for a write
       * not confirmed after an attempt nothing answered, the certain failure the repeat was
       * answered (`qb_not_connected`, `platform_busy`, `deadline_exceeded`, `401`, `6210`, …).
       */
      readonly detail?: string;
    };

/** How a failure is built: its reason, whether a record may exist, and its word for the timeline. */
type Failed = (
  reason: QuickBooksWriteFailure,
  created: false | 'unknown',
  detail?: string,
) => QuickBooksWrite;

/**
 * The step platforms whose write was thrown on unanswered — no answer, or a refusal the
 * platform did not decide — so that the step's next attempt, handed the same object, knows
 * an earlier one may have made the record.
 */
const unanswered = new WeakSet<object>();

/** The platform's own word for why, when it is one: lowercase letters, digits and `_`. */
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * The SDK's transient refusal (its `isTransient`, read here by shape): a 502, 503 or 504 that
 * names no reason, its code the platform's `DEPENDENCY_FAILURE` or none — the platform did not
 * decide, and may not have reached QuickBooks.
 */
function undecided(refusal: NonNullable<ReturnType<typeof refusalOf>>): boolean {
  return (
    [502, 503, 504].includes(refusal.status) &&
    refusal.reason === undefined &&
    (refusal.code === undefined || refusal.code === 'DEPENDENCY_FAILURE')
  );
}

export async function writeQuickBooks(write: QuickBooksWriteRequest): Promise<QuickBooksWrite> {
  const { operation, entity, noun } = QUICKBOOKS_WRITES[write.kind];
  if (Object.hasOwn(write.input, 'requestid')) {
    throw new Error(`${operation} input names requestid; the platform adds the request id`);
  }
  const sentences = writeSentences(noun);
  const failed: Failed = (reason, created, detail) => ({
    ok: false,
    reason,
    created,
    sentence: sentences[reason],
    ...(detail === undefined ? {} : { detail }),
  });

  let answer: ProviderAnswer;
  try {
    answer = await write.platform.callProvider({
      providerId: 'quickbooks',
      operation,
      input: write.input,
    });
  } catch (error) {
    const refusal = refusalOf(error);
    // No answer at all, or a refusal the platform did not decide: on unchanged, for the step's
    // retry to repeat under the same key and `requestid` (S6) — anything this code cannot read
    // too, which the SDK repeats only when it marked it as an answer that never came. Noted
    // first: this attempt may have made the record, whatever the next one is answered.
    if (!refusal || undecided(refusal)) {
      unanswered.add(write.platform);
      throw error;
    }
    return afterUnanswered(write, refused(refusal, failed), failed);
  }
  return afterUnanswered(write, answered(answer, entity, failed), failed);
}

/** A refusal the platform decided: certain when nothing can have reached QuickBooks. */
function refused(
  refusal: NonNullable<ReturnType<typeof refusalOf>>,
  failed: Failed,
): QuickBooksWrite {
  const { status, reason } = refusal;
  const word = reason !== undefined && REASON_WORD.test(reason) ? reason : undefined;
  if (status === 404) return failed('qb_not_connected', false);
  if (status === 400 && reason === 'insufficient_scope') return failed('qb_missing_scope', false);
  if (status === 503 && reason === 'connections_not_configured') {
    return failed('qb_not_configured', false);
  }
  // The Edge's flood valve turns the callback away before it reaches the platform.
  if (status === 429) return failed('platform_busy', false);
  if (
    status === 400 ||
    (status === 403 && (reason === 'provider_not_declared' || reason === 'deadline_exceeded'))
  ) {
    return failed('platform_refused', false, word ?? 'refused');
  }
  // 409 idempotency_key_reused: an earlier copy of this step sent another body under
  // the key, and may have created a record. Anything else this code does not know: the
  // same caution.
  return failed('qb_unconfirmed', 'unknown', word ?? String(status));
}

/** QuickBooks' own answer: the record and its Id, or whether a record may exist. */
function answered(answer: ProviderAnswer, entity: string, failed: Failed): QuickBooksWrite {
  const { status, body } = answer;
  // QuickBooks may have acted before it failed: Intuit's advice on a 500 is to resubmit.
  if (status >= 500 || status === 429 || status === 408 || status === 425) {
    return failed('qb_unconfirmed', 'unknown', String(status));
  }
  if (status === 401) return failed('qb_reauthorize', false, '401');
  if (status === 403) return failed('qb_forbidden', false, '403');
  const fault = faultOf(body);
  if (fault) {
    // 600: "Duplicate Request ID" — the first request under this id may have made the record.
    if (fault.code === '600') return failed('qb_unconfirmed', 'unknown', '600');
    return failed('qb_refused', false, fault.code ?? String(status));
  }
  if (status < 200 || status >= 300) return failed('qb_refused', false, String(status));
  const record = entityOf(body, entity);
  const id = record?.Id;
  if (!record || typeof id !== 'string' || id.trim() === '') {
    return failed('qb_unconfirmed', 'unknown', 'no_id');
  }
  return { ok: true, id, record };
}

/**
 * A failure certain that nothing was created, once an earlier attempt of this step's write
 * was thrown on unanswered, is no longer certain: that attempt may have made the record. It
 * says QuickBooks did not confirm it, naming what this attempt was answered.
 */
function afterUnanswered(
  write: QuickBooksWriteRequest,
  verdict: QuickBooksWrite,
  failed: Failed,
): QuickBooksWrite {
  if (verdict.ok || verdict.created !== false || !unanswered.has(write.platform)) return verdict;
  return failed('qb_unconfirmed', 'unknown', verdict.detail ?? verdict.reason);
}
