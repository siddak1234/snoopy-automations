import { QUICKBOOKS_NUMBER_LENGTH, addDays } from '@autom8x/automation-kit/values';

import { KEPT_TYPES, type KeptType } from '../document.js';
import { hasWebAddress } from '../names.js';
import type { DocumentState, Finding } from '../state.js';
import { firstReadOf } from './answers.js';
import { amountsOf, type Amounts } from './arithmetic.js';
import { cleanFirstRead, unclearFieldsOf, type Cleaned } from './clean.js';
import { routeOf } from './route.js';
import { failedRule, recordingRule, type DocumentRule, type RecordingRule } from './rules.js';

/**
 * `check-document`'s decision, a pure function of the first read, the company and the run's date
 * (the plan's §2.1–§2.5, as v2's §2.6 splits the rules): the rule the document cannot be used
 * under, which ends the run on either path; or the cleaned document, its route and what it found —
 * and, on the QuickBooks path, the first rule QuickBooks cannot record it under, if any. No
 * QuickBooks or model call; the same input gives the same answer, so a run re-sent after a lost
 * acknowledgement reaches it again.
 */

export interface CheckInput {
  /** `state.extraction`: read 1's answer as the platform held it to its schema. */
  readonly answer: unknown;
  /** The QuickBooks path: the recording rules are weighed. */
  readonly quickBooks: boolean;
  /** The company's names, for C10; null with the vendor "None". */
  readonly companyName: string | null;
  readonly legalName: string | null;
  /** The run's UTC date, `YYYY-MM-DD`. */
  readonly today: string;
}

export type CheckOutcome =
  | {
      readonly outcome: 'ok';
      readonly document: DocumentState;
      /** On the QuickBooks path, the first rule QuickBooks cannot record the document under. */
      readonly recordingRule: RecordingRule | undefined;
    }
  | { readonly outcome: 'failed'; readonly rule: DocumentRule | 'answer_unusable' };

/** A bill's due date: printed; else its date plus the printed terms; else none (as designed). */
function dueDateOf(
  cleaned: Cleaned,
): Pick<DocumentState, 'dueDate' | 'dueDateSource' | 'termsDiffer'> {
  const date = cleaned.date.kind === 'date' ? cleaned.date.date : null;
  const fromTerms =
    date !== null && cleaned.termsDays !== null ? addDays(date, cleaned.termsDays) : null;
  if (cleaned.dueDate.kind === 'date') {
    const printed = cleaned.dueDate.date;
    return {
      dueDate: printed,
      dueDateSource: 'printed',
      termsDiffer: fromTerms !== null && fromTerms !== printed,
    };
  }
  if (fromTerms !== null) return { dueDate: fromTerms, dueDateSource: 'terms', termsDiffer: false };
  return { dueDate: null, dueDateSource: 'none', termsDiffer: false };
}

/**
 * What the document hands decide to hold on, in the order of the plan's §2.4: a bill listing
 * other invoices (5), an earlier balance (10), a refund method not shown (11), a tip added (12),
 * amounts that don't add up (13), unclear fields (16), a total not cross-checked (17), a currency
 * not recognised (20). A statement never holds, so it hands none.
 */
export function findingsOf(
  document: Pick<
    DocumentState,
    'route' | 'listedInvoiceCount' | 'refundMethod' | 'currencyUnrecognised'
  >,
  amounts: Pick<Amounts, 'findings'>,
  unclearFields: readonly string[],
): Finding[] {
  if (document.route === 'statement') return [];
  const arithmetic = new Set(amounts.findings);
  const findings: Finding[] = [];
  if (document.route === 'bill' && document.listedInvoiceCount > 0) {
    findings.push('lists_other_invoices');
  }
  if (arithmetic.has('earlier_balance')) findings.push('earlier_balance');
  if (
    document.route === 'vendor_credit' &&
    (document.refundMethod === 'not_shown' || document.refundMethod === 'not_applicable')
  ) {
    findings.push('refund_method_not_shown');
  }
  if (arithmetic.has('tip_added')) findings.push('tip_added');
  if (arithmetic.has('amounts_mismatch')) findings.push('amounts_mismatch');
  if (unclearFields.length > 0) findings.push('unclear_fields');
  if (arithmetic.has('not_cross_checked')) findings.push('not_cross_checked');
  if (document.currencyUnrecognised) findings.push('currency_unrecognised');
  return findings;
}

export function checkFirstRead(input: CheckInput): CheckOutcome {
  const read = firstReadOf(input.answer);
  if (!read) return { outcome: 'failed', rule: 'answer_unusable' };
  const cleaned = cleanFirstRead(read);
  const type = (KEPT_TYPES as readonly string[]).includes(read.documentType)
    ? (read.documentType as KeptType)
    : null;
  const amounts =
    type !== null && type !== 'supplier_statement' && cleaned.total.kind === 'cents'
      ? amountsOf(
          type,
          cleaned.parts,
          cleaned.signs,
          cleaned.total.cents,
          cleaned.tipCents,
          cleaned.amountDueCents,
        )
      : null;
  const context = {
    cleaned,
    companyName: input.companyName,
    legalName: input.legalName,
    today: input.today,
    amounts,
  };
  const rule = failedRule(context);
  if (rule !== undefined) return { outcome: 'failed', rule };
  // Past C1–C4 the type is one this automation keeps; past C8 there is a seller; past C11 a
  // record has a total — in whole cents, its arithmetic run, unless C12 or C13 would say not.
  if (type === null || cleaned.seller === null)
    return { outcome: 'failed', rule: 'answer_unusable' };

  const route = routeOf(type, read.refundMethod);
  const unclearFields = route === 'statement' ? [] : unclearFieldsOf(cleaned, route);
  const totalCents = cleaned.total.kind === 'cents' ? cleaned.total.cents : null;
  const number = cleaned.number;
  const base = {
    route,
    listedInvoiceCount: cleaned.listedInvoiceCount,
    refundMethod: read.refundMethod,
    currencyUnrecognised: cleaned.currency.kind === 'unrecognised',
  };
  const document: DocumentState = {
    type,
    route,
    seller: cleaned.seller,
    sellerHasWebAddress: hasWebAddress(cleaned.seller),
    number,
    numberUsable: number !== null && number.length <= QUICKBOOKS_NUMBER_LENGTH,
    date: cleaned.date.kind === 'date' ? cleaned.date.date : null,
    ...(type === 'bill'
      ? dueDateOf(cleaned)
      : { dueDate: null, dueDateSource: 'none' as const, termsDiffer: false }),
    currency: cleaned.currency.kind === 'code' ? cleaned.currency.code : null,
    currencyUnrecognised: base.currencyUnrecognised,
    totalCents,
    amountCents: amounts?.amountCents ?? null,
    amountDueCents: cleaned.amountDueCents,
    earlierBalanceCents: amounts?.earlierBalanceCents ?? null,
    tipCents: cleaned.tipCents,
    tip: amounts?.tip ?? 'none',
    paymentMethod: read.paymentMethod,
    cardLast4: cleaned.card.kind === 'digits' ? cleaned.card.digits : null,
    cardDigitsUnclear: cleaned.card.kind === 'unclear',
    cashBackPrinted: read.cashBackPrinted,
    refundMethod: read.refundMethod,
    originalInvoiceNumber: cleaned.originalInvoiceNumber,
    spendType: read.spendType,
    spendTypeUnclear: cleaned.spendTypeUnclear,
    listedInvoiceCount: cleaned.listedInvoiceCount,
    statement: cleaned.statement,
    arithmetic: {
      ...cleaned.parts,
      signs: cleaned.signs,
      parts: amounts?.parts ?? 'not_run',
      lines: amounts?.lines ?? 'not_run',
    },
    findings: findingsOf(base, amounts ?? { findings: [] }, unclearFields),
    unclearFields,
  };
  return {
    outcome: 'ok',
    document,
    recordingRule: input.quickBooks ? recordingRule(context) : undefined,
  };
}
