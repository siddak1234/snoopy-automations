import type { QuickBooksRead, QuickBooksWrite } from '@autom8x/automation-kit/quickbooks';
import {
  CONNECTION_NONE,
  isObject,
  type InvokeRequest,
  type JsonObject,
  type StepResult,
} from '@autom8x/automation-sdk';

/**
 * Whether this run records in QuickBooks (v2: QuickBooks is optional — the platform's ADR-0037,
 * BUILD-PLAN 25.4.16 and 25.4.17). The flow's vendor choice is the manifest's one `connection`
 * setup field, `vendor`, which reaches the run in its `config`: `quickbooks`, or `none` — its
 * default, and what anything else, or nothing, reads as here, so no setting can fail a run (U7).
 *
 * - **None**: no QuickBooks step runs and nothing calls QuickBooks; the document is read, checked
 *   and its details saved (`save-details`).
 * - **QuickBooks**: the run records the document, unless QuickBooks will not take it — one of its
 *   recording rules (the spec's S2), or QuickBooks failing mid-run (the session's decision 6,
 *   approved in advance by the owner's "approve. complete"): then `state.quickBooks` says why, every
 *   later QuickBooks step is skipped, the details are saved, and the result says "Saved. Not
 *   recorded in QuickBooks: …" — or, for a write QuickBooks may have made, "Saved. QuickBooks didn't
 *   confirm. Check QuickBooks before you run it again." The run never fails for it.
 */

/** The manifest's `connection` field, and the one vendor this automation records with. */
export const VENDOR_KEY = 'vendor';
export const QUICKBOOKS = 'quickbooks';

export type VendorChoice = typeof QUICKBOOKS | typeof CONNECTION_NONE;

/** The flow's choice: QuickBooks only when the setting says exactly that. */
export function vendorChoiceOf(config: JsonObject): VendorChoice {
  return config[VENDOR_KEY] === QUICKBOOKS ? QUICKBOOKS : CONNECTION_NONE;
}

/**
 * Why QuickBooks will not record this document, in the spec's words (§3.F, "Reasons"), each read
 * after "Not recorded in QuickBooks: ". The last two are §2.6's hold phrases, for the checks an
 * approval repeats.
 */
export const NOT_RECORDED = {
  not_connected: "QuickBooks isn't connected",
  no_answer: "QuickBooks didn't answer",
  not_us: 'only US companies work',
  not_usd: 'only US dollars work',
  closed_books: 'that date is in closed books',
  vendor_currency: 'the vendor uses another currency',
  vendor_name_too_long: "the vendor's name is too long",
  no_uncategorized: 'add an Uncategorized Expense account',
  no_paying_account: 'add a bank or card account',
  refund_needs_card: 'refunds need a card account',
  own_company: 'your own company issued it',
  total_zero: 'the total is zero',
  total_too_large: 'the total is too large',
  number_too_long: 'the number is too long',
  part_paid: 'part may already be paid',
  cash_back: 'it includes cash back',
  still_owed: 'money is still owed',
  refunded_by_check: 'refunded by check or cash',
  future_date: "it's dated in the future",
  due_date_unreadable: "the due date can't be read",
  due_before_date: 'the due date is before the date',
  tip_unclear: 'unclear if the total includes the tip',
  credit_needs_vendor: 'credit notes need an existing vendor',
  vendor_not_in_quickbooks: "the vendor isn't in QuickBooks",
  reads_disagree_type: 'the two reads disagree on the type',
  may_already_be_recorded: 'may already be in QuickBooks',
  name_in_use: 'name used by a customer or employee',
} as const;

export type NotRecordedReason = keyof typeof NOT_RECORDED;

/** What became of QuickBooks once the run stopped using it. */
export type QuickBooksState =
  | { readonly notRecorded: string }
  /** A write nothing answered: QuickBooks may have made it. */
  | { readonly unconfirmed: true };

/** `state.quickBooks`: absent while the run still records in QuickBooks; undefined when malformed. */
export function quickBooksStateOf(state: JsonObject): QuickBooksState | null | undefined {
  const value = state.quickBooks;
  if (value === undefined) return null;
  if (!isObject(value)) return undefined;
  if (typeof value.notRecorded === 'string' && value.notRecorded !== '') {
    return { notRecorded: value.notRecorded };
  }
  return value.unconfirmed === true ? { unconfirmed: true } : undefined;
}

/** Whether this step is on the QuickBooks path: QuickBooks chosen, and nothing has stopped it. */
export function onQuickBooksPath(
  request: Pick<InvokeRequest, 'config'>,
  state: JsonObject,
): boolean {
  return vendorChoiceOf(request.config) === QUICKBOOKS && state.quickBooks === undefined;
}

/** The line a step says when QuickBooks will not record this document (§3.E). */
export const notRecordedLine = (reason: NotRecordedReason): string =>
  `Not recorded in QuickBooks: ${NOT_RECORDED[reason]}`;

/** The line a write QuickBooks did not confirm says — §3.F's sentence, after "Saved. ". */
export const UNCONFIRMED_LINE =
  "QuickBooks didn't confirm. Check QuickBooks before you run it again.";

/**
 * QuickBooks will not record this document: the step ends — failed for a QuickBooks call that
 * failed, ok for a rule the document meets — WITHOUT a failure reason, so the run goes on (the
 * SDK's runner), and the state says why for every later step.
 */
export function notRecorded(
  state: JsonObject,
  reason: NotRecordedReason,
  outcome: 'failed' | 'ok' = 'failed',
): StepResult {
  return {
    outcome,
    summary: notRecordedLine(reason),
    state: { ...state, quickBooks: { notRecorded: NOT_RECORDED[reason] } },
  };
}

/** A write QuickBooks may have made: the details are saved, and the result says to check QuickBooks. */
export function unconfirmed(state: JsonObject): StepResult {
  return {
    outcome: 'failed',
    summary: UNCONFIRMED_LINE,
    state: { ...state, quickBooks: { unconfirmed: true } },
  };
}

/**
 * A QuickBooks read that failed, as decision 6 words it (§3.F): not connected — the connection
 * gone, needing a reconnection, refused, or without the accounting scope — or else QuickBooks did
 * not answer usably: busy, an error, a refusal on the platform's side.
 */
export function readFailed(
  state: JsonObject,
  read: Extract<QuickBooksRead, { ok: false }>,
): StepResult {
  const notConnected = ['qb_not_connected', 'qb_reauthorize', 'qb_forbidden', 'qb_missing_scope'];
  return notRecorded(state, notConnected.includes(read.reason) ? 'not_connected' : 'no_answer');
}

/**
 * A QuickBooks write that failed. One QuickBooks may have made is `unconfirmed`; a certain one is
 * not recorded, in the nearest of §3.F's words: not connected; a date in closed books (Intuit's
 * 6200, 6210); a number already used (6140) or a name already used (6240); else no usable answer.
 */
export function writeFailed(
  state: JsonObject,
  write: Extract<QuickBooksWrite, { ok: false }>,
): StepResult {
  if (write.created !== false) return unconfirmed(state);
  const notConnected = ['qb_not_connected', 'qb_reauthorize', 'qb_forbidden', 'qb_missing_scope'];
  if (notConnected.includes(write.reason)) return notRecorded(state, 'not_connected');
  if (write.reason === 'qb_refused') {
    switch (write.detail) {
      case '6200':
      case '6210':
        return notRecorded(state, 'closed_books');
      case '6140':
        return notRecorded(state, 'may_already_be_recorded');
      case '6240':
        return notRecorded(state, 'name_in_use');
      default:
        break;
    }
  }
  return notRecorded(state, 'no_answer');
}
