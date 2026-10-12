import type { JsonObject, ProviderAnswer, StepPlatform } from '@autom8x/automation-sdk';

import { entityOf, faultOf } from './answers.js';
import { refusalOf } from './read.js';

/**
 * One QuickBooks WRITE through the SDK's provider call — a bill, an expense, a vendor
 * credit, a journal entry or a vendor — judged so that a step never makes a second record:
 *
 * **Never repeated.** One request, whatever happens: no wait after a 429, no second try
 * after a 5xx, nothing thrown for the SDK's step retry to repeat (a step that writes
 * declares no retry). Connections replays a recorded final answer for the step's key, and
 * Intuit's `requestid` covers the window Connections cannot: the PLATFORM derives it from
 * the step's key and puts it on the URL (its BUILD-PLAN 25.2.26), so the input never
 * carries one — a `requestid` in it is the caller's mistake, refused before anything is sent.
 *
 * **Did it happen?** Each failure says whether a record may exist. Certain — refused
 * before QuickBooks, or refused by QuickBooks with a Fault or a 4xx — says no record was
 * created. Uncertain — no answer, a 502/503/504 naming no reason, a 5xx, 408, 425 or 429
 * from QuickBooks, Intuit's Fault 600 (a repeated request id), a 409 for another body
 * under the key, a 2xx without the record's Id — says QuickBooks did not confirm it, in a
 * fixed sentence that sends the person to check QuickBooks before running it again.
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
      /** The Fault code, QuickBooks' status, or the platform's reason word. */
      readonly detail?: string;
    };

/** The platform's own word for why, when it is one: lowercase letters, digits and `_`. */
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/u;

export async function writeQuickBooks(write: QuickBooksWriteRequest): Promise<QuickBooksWrite> {
  const { operation, entity, noun } = QUICKBOOKS_WRITES[write.kind];
  if (Object.hasOwn(write.input, 'requestid')) {
    throw new Error(`${operation} input names requestid; the platform adds the request id`);
  }
  const sentences = writeSentences(noun);
  const failed = (
    reason: QuickBooksWriteFailure,
    created: false | 'unknown',
    detail?: string,
  ): QuickBooksWrite => ({
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
    if (!refusal) return failed('qb_unconfirmed', 'unknown');
    const { status, reason } = refusal;
    const word = reason !== undefined && REASON_WORD.test(reason) ? reason : undefined;
    if (status === 404) return failed('qb_not_connected', false);
    if (status === 400 && reason === 'insufficient_scope') {
      return failed('qb_missing_scope', false);
    }
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
    // the key, and may have created a record. A reasonless 502/503/504: it may have
    // reached QuickBooks. Anything else this code does not know: the same caution.
    return failed('qb_unconfirmed', 'unknown', word ?? String(status));
  }

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
