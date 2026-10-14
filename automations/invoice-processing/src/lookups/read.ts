import {
  queryRowsOf,
  readQuickBooks,
  type Clock,
  type QuickBooksFailureReason,
} from '@autom8x/automation-kit/quickbooks';
import {
  isObject,
  type JsonObject,
  type StepContext,
  type StepResult,
} from '@autom8x/automation-sdk';

import { vendorOf, type VendorState } from '../decide/contract.js';
import { KEPT_TYPES, ROUTES } from '../document.js';
import { runFails } from '../outcome.js';
import { notRecorded, readFailed } from '../quickbooks-path.js';
import type { DocumentState } from '../state.js';
import { instantOf } from './records.js';

/**
 * What every lookup shares: the state it reads, and its one QuickBooks read — the kit's
 * `readQuickBooks`, which waits out a 429 and repeats a 5xx once inside the step. On the QuickBooks
 * path only. A read that fails — QuickBooks not connected, refusing the query, or answering
 * unusably — is "not recorded in QuickBooks", and the run goes on to save the details (decision 6);
 * a state no earlier step left so is a guard that should never fire, and ends the run.
 */

/** A guard that should never fire: a key an earlier step writes is missing or malformed. */
export function incomplete(): StepResult {
  return runFails('other', 'state_incomplete');
}

const isDay = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const isTextOrNull = (value: unknown) => value === null || typeof value === 'string';

/**
 * `check-document`'s document, as far as the lookups read it — its route and type, the seller, the
 * number, the dates and the amount a record carries, a credit's original number and a statement's
 * rows — or undefined when one of those is missing or malformed.
 */
export function lookupDocumentOf(state: JsonObject): DocumentState | undefined {
  const document = state.document;
  if (
    !isObject(document) ||
    !(ROUTES as readonly unknown[]).includes(document.route) ||
    !(KEPT_TYPES as readonly unknown[]).includes(document.type) ||
    typeof document.seller !== 'string' ||
    document.seller === '' ||
    !isTextOrNull(document.number) ||
    typeof document.numberUsable !== 'boolean' ||
    !isTextOrNull(document.originalInvoiceNumber) ||
    (document.dueDate !== null && !isDay(document.dueDate))
  ) {
    return undefined;
  }
  if (document.route === 'statement') {
    const rows = isObject(document.statement) ? document.statement.rows : undefined;
    const readable =
      Array.isArray(rows) &&
      rows.every((row) => isObject(row) && typeof row.reference === 'string');
    return readable ? (document as unknown as DocumentState) : undefined;
  }
  // A record's date and amount: what every lookup but a statement's searches by.
  const amount = document.amountCents;
  const dated = isDay(document.date);
  const priced = typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0;
  return dated && priced ? (document as unknown as DocumentState) : undefined;
}

/** find-vendor's answer: the vendor, null before it ran or where none is looked for, undefined when malformed. */
export const lookupVendorOf = (state: JsonObject): VendorState | null | undefined =>
  vendorOf(state.vendor);

/** A lookup's read: the rows, or the failure — its reason kept for the steps that carry on past one. */
export type Rows =
  | {
      readonly ok: true;
      readonly rows: JsonObject[];
      /** QuickBooks' own clock when it answered (the answer's `time`); null when it gave none. */
      readonly answeredAt: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: QuickBooksFailureReason | 'unexpected_answer';
      /** "Not recorded in QuickBooks", the state saying why. */
      readonly result: StepResult;
    };

export interface LookupRead {
  readonly context: Pick<StepContext, 'platform' | 'request' | 'state'>;
  readonly clock: Clock;
  readonly query: string;
  /** The entity whose rows the answer holds: `QueryResponse.<entity>`. */
  readonly entity: string;
  /** What the read is for, as the kit's sentences would say it. */
  readonly purpose: string;
}

/**
 * The one `query.run` of a lookup, built once so every attempt sends the same bytes under the
 * step's one key. Any failure QuickBooks or the platform answered, and a body that is no query
 * answer, is "not recorded in QuickBooks" (decision 6); a platform failure no answer judged — no
 * answer, a 502 naming no reason — is thrown on unchanged, for the SDK's step retry, and the run's
 * `recover` says the same once its attempts are spent.
 */
export async function lookupRows(read: LookupRead): Promise<Rows> {
  const { state } = read.context;
  const answer = await readQuickBooks({
    platform: read.context.platform,
    deadline: read.context.request.deadline,
    clock: read.clock,
    operation: 'query.run',
    input: { query: read.query },
    purpose: read.purpose,
  });
  if (!answer.ok) return { ok: false, reason: answer.reason, result: readFailed(state, answer) };
  const rows = queryRowsOf(answer.body, read.entity);
  if (!rows) {
    return { ok: false, reason: 'unexpected_answer', result: notRecorded(state, 'no_answer') };
  }
  const time = isObject(answer.body) ? answer.body.time : undefined;
  return {
    ok: true,
    rows,
    answeredAt: typeof time === 'string' && instantOf(time) !== undefined ? time : null,
  };
}
