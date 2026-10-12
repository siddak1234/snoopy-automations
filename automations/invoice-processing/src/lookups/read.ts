import {
  QUICKBOOKS_SENTENCES,
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
import { failedWith, quickBooksFailed } from '../outcome.js';
import type { DocumentState, PayerState } from '../state.js';
import { instantOf } from './records.js';

/**
 * What every lookup (steps 9–17) shares: its fixed sentences, the state it reads, and its one
 * QuickBooks read — the kit's `readQuickBooks`, which waits out a 429 and repeats a 5xx once
 * inside the step and words every connection failure as every QuickBooks step does.
 */

/**
 * The lookups' own sentences (ip-review design-quickbooks-lookups.json, its outcomes), each ending as
 * this automation's others do — "run it again" for a document of any type, then "Nothing was
 * created." A vendor that is a person who paid has its own words, so they are never read as the
 * seller's: "The person in 'Who paid'…" is find-payer's own, for an employee (P2).
 */
export const LOOKUP_SENTENCES = {
  vendor_inactive:
    'This vendor is inactive in QuickBooks. Reactivate it in QuickBooks, then run it again. Nothing was created.',
  vendor_ambiguous:
    'Two vendors in QuickBooks have this name. Make the names different in QuickBooks, then run it again. Nothing was created.',
  vendor_company_inactive:
    'The vendor with this company name is inactive in QuickBooks. Reactivate it in QuickBooks, then run it again. Nothing was created.',
  vendor_company_ambiguous:
    'Two vendors in QuickBooks have this company name. Make them different in QuickBooks, then run it again. Nothing was created.',
  payer_inactive:
    "The person in 'Who paid' is inactive in QuickBooks. Make them active, then run it again. Nothing was created.",
  payer_ambiguous:
    "Two QuickBooks vendors have the name in 'Who paid'. Rename one in QuickBooks, then run it again. Nothing was created.",
  /** V1: the plan's §2.3. */
  payer_not_found:
    "The name in 'Who paid' isn't an employee or vendor in QuickBooks, or an owner in this flow's settings. Type it as QuickBooks shows it, then run it again. Nothing was created.",
  vendor_refused:
    "QuickBooks could not search for this vendor's name. Enter it by hand in QuickBooks. Nothing was created.",
  vendor_company_refused:
    "QuickBooks could not search for this vendor's company name. Enter it by hand in QuickBooks. Nothing was created.",
  payer_refused:
    "QuickBooks could not search for the name in 'Who paid'. Enter it by hand in QuickBooks. Nothing was created.",
  customer_refused:
    'QuickBooks could not check customer names for this vendor. Enter it by hand in QuickBooks. Nothing was created.',
  number_refused:
    'QuickBooks could not search for records with this number. Enter it by hand in QuickBooks. Nothing was created.',
  amount_refused:
    'QuickBooks could not search for records with this amount. Enter it by hand in QuickBooks. Nothing was created.',
  related_refused:
    'QuickBooks could not search for a record this one relates to. Enter it by hand in QuickBooks. Nothing was created.',
  other_record_refused:
    'QuickBooks could not search for this purchase recorded another way. Enter it by hand in QuickBooks. Nothing was created.',
  /** A statement's: it is compared with QuickBooks, never entered (D26). */
  statement_vendor_refused:
    "QuickBooks could not search for this statement's vendor. Compare the statement in QuickBooks. Nothing was created.",
  statement_number_refused:
    "QuickBooks could not search this vendor's bills for the invoices the statement lists. Compare the statement in QuickBooks. Nothing was created.",
  statement_amount_refused:
    "QuickBooks could not search this vendor's open bills. Compare the statement in QuickBooks. Nothing was created.",
  /** A guard that should never fire: a key an earlier step writes is missing or malformed. */
  state_incomplete:
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
} as const;

export type LookupSentence = keyof typeof LOOKUP_SENTENCES;

/** A run the step ends, with the line's words and its reason. */
export function refused(what: string, reason: LookupSentence): StepResult {
  return failedWith(what, reason, LOOKUP_SENTENCES[reason]);
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

/** find-payer's answer, when someone paid personally: their name as cleaned. */
export function payerNameOf(state: JsonObject): string | undefined {
  const payer = state.payer;
  return isObject(payer) && typeof payer.name === 'string' && payer.name !== ''
    ? (payer as unknown as PayerState).name
    : undefined;
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
      readonly result: StepResult;
    };

export interface LookupRead {
  readonly context: Pick<StepContext, 'platform' | 'request'>;
  readonly clock: Clock;
  readonly query: string;
  /** The entity whose rows the answer holds: `QueryResponse.<entity>`. */
  readonly entity: string;
  /** The timeline's words when the step fails: "Vendor not looked up". */
  readonly what: string;
  /** What the read is for, as the kit's sentences would say it. */
  readonly purpose: string;
  /** The step's own sentence when QuickBooks refuses the query — a Fault, or a 4xx it records. */
  readonly refused: LookupSentence;
}

/**
 * The one `query.run` of a lookup, built once so every attempt sends the same bytes under the
 * step's one key. QuickBooks' refusal of the query ends the run with the step's sentence — its code
 * in the line, never Intuit's words; every other failure with the kit's; a body that is no query
 * answer with the unexpected-answer sentence. A platform failure no answer judged — no answer, a
 * 502 naming no reason — is thrown on unchanged, for the SDK's step retry and then the run's fixed
 * sentence.
 */
export async function lookupRows(read: LookupRead): Promise<Rows> {
  const answer = await readQuickBooks({
    platform: read.context.platform,
    deadline: read.context.request.deadline,
    clock: read.clock,
    operation: 'query.run',
    input: { query: read.query },
    purpose: read.purpose,
  });
  if (!answer.ok) {
    const result =
      answer.reason === 'qb_error'
        ? failedWith(
            read.what,
            answer.detail === undefined ? 'qb_error' : `qb_error ${answer.detail}`,
            LOOKUP_SENTENCES[read.refused],
          )
        : quickBooksFailed(read.what, answer);
    return { ok: false, reason: answer.reason, result };
  }
  const rows = queryRowsOf(answer.body, read.entity);
  if (!rows) {
    return {
      ok: false,
      reason: 'unexpected_answer',
      result: failedWith(read.what, 'unexpected_answer', QUICKBOOKS_SENTENCES.unexpected_answer),
    };
  }
  const time = isObject(answer.body) ? answer.body.time : undefined;
  return {
    ok: true,
    rows,
    answeredAt: typeof time === 'string' && instantOf(time) !== undefined ? time : null,
  };
}
