import type { Clock } from '@autom8x/automation-kit/quickbooks';
import {
  fitLine,
  formatMoney,
  shorten,
  utcDay,
  withinOneCent,
  type LinePiece,
} from '@autom8x/automation-kit/values';
import { isObject, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { checkFirstRead } from '../checks/check.js';
import { namedFields } from '../checks/fields.js';
import { CHECK_DOCUMENT_REASONS, CHECK_DOCUMENT_SENTENCES } from '../checks/rules.js';
import { PAID_PERSONALLY, type Route } from '../document.js';
import { failedWith } from '../outcome.js';
import type { AccountRef, DocumentState, Finding, PayerState } from '../state.js';

/**
 * `check-document` (step 7, code only) — the first read cleaned once, routed, and held to the fail
 * rules (the plan's §2.1–§2.5): a document that can never be recorded correctly ends here with one
 * fixed sentence, before any QuickBooks lookup or second read is spent; any other goes on with its
 * clean values, its route and what it found for decide, in `state.document`. The raw answer leaves
 * the state here, so no line item, no word printed beside one, ever travels further.
 */

/** The guards that should never fire, and the could-not-be-read sentence. */
export const CHECK_DOCUMENT_GUARDS = {
  answer_unusable:
    'The document could not be read. Try a clearer photo or the PDF. Nothing was created.',
  state_incomplete:
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
} as const;

const WHAT = 'Checked, not recorded';

/** What the timeline says the document is. */
function whatItIs(document: DocumentState, switchOn: boolean): string {
  const routes: Readonly<Record<Route, string>> = {
    bill: 'a bill',
    company_receipt: 'a receipt',
    card_refund: 'a refund to a card',
    vendor_credit: 'a credit note',
    statement: switchOn
      ? "a supplier statement (the switch doesn't apply)"
      : 'a supplier statement',
    employee: '',
    owner: '',
    contractor: '',
  };
  return PAID_PERSONALLY.has(document.route)
    ? `a ${document.type === 'bill' ? 'bill' : 'receipt'} paid personally`
    : routes[document.route];
}

/** One finding as the timeline words it. */
function findingWords(finding: Finding, document: DocumentState): string {
  const money = (cents: number | null) => formatMoney(cents ?? 0, document.currency ?? 'USD');
  switch (finding) {
    case 'lists_other_invoices':
      return `lists ${document.listedInvoiceCount} other invoice${document.listedInvoiceCount === 1 ? '' : 's'}`;
    case 'earlier_balance':
      return `earlier balance ${money(document.earlierBalanceCents)} also due`;
    case 'refund_method_not_shown':
      return 'refund method not shown';
    case 'tip_added':
      return `tip of ${money(document.tipCents)} added to the printed total`;
    case 'amounts_mismatch':
      return "amounts don't add up";
    case 'unclear_fields':
      return `unclear: ${namedFields(document.unclearFields)}`;
    case 'not_cross_checked':
      return 'total not cross-checked';
    case 'currency_unrecognised':
      return 'currency not recognised';
  }
}

/** A statement's rows as the timeline counts them: whether they add up to its balance. */
function rowsWords(document: DocumentState): string {
  const statement = document.statement;
  const count = statement?.rows.length ?? 0;
  const rows = `${count} row${count === 1 ? '' : 's'}`;
  if (!statement?.complete) return `${rows}, more not listed`;
  if (statement.ownSumCents === null || document.totalCents === null) return rows;
  return withinOneCent(statement.ownSumCents, document.totalCents)
    ? `${rows} that add up`
    : `${rows} that differ by ${formatMoney(Math.abs(statement.ownSumCents - document.totalCents))}`;
}

/**
 * The timeline line, at most 200 characters: what was found first ("Checks passed" when nothing
 * was), then what the document is, its amount, date, due date, number (cut to 30) and the seller
 * last, the one piece shortened to fit. Never a line item or a word printed beside one.
 */
export function checkedSummary(document: DocumentState, switchOn: boolean): string {
  const found = document.findings.map((finding) => findingWords(finding, document));
  const head = found.length === 0 ? 'Checks passed' : found.join('; ');
  const currency = document.currency ?? 'USD';
  const parts: string[] = [whatItIs(document, switchOn)];
  if (document.route === 'statement') {
    parts.push(
      document.totalCents === null
        ? 'balance not read'
        : `balance ${formatMoney(document.totalCents, currency)}`,
    );
  } else if (document.amountCents !== null) {
    parts.push(formatMoney(document.amountCents, currency));
  }
  if (document.date !== null) parts.push(`dated ${document.date}`);
  if (document.type === 'bill' && document.route === 'bill') {
    const due =
      document.dueDateSource === 'none'
        ? 'no due date'
        : `due ${document.dueDate}${document.dueDateSource === 'terms' ? ' (from terms)' : ''}`;
    parts.push(document.termsDiffer ? `${due} (terms differ)` : due);
  }
  if (document.route === 'statement') parts.push(rowsWords(document));
  if (document.number !== null) parts.push(shorten(document.number, 30));
  const pieces: LinePiece[] = [`${head[0]!.toUpperCase()}${head.slice(1)}: ${parts.join(', ')}, `];
  pieces.push({ name: document.seller });
  return fitLine(pieces);
}

/** The company's names, the payer and Paid from, as the checks read them; undefined when one is missing. */
function contextOf(state: JsonObject, switchOn: boolean) {
  const { company, accounts, payer } = state;
  if (!isObject(company) || typeof company.name !== 'string') return undefined;
  if (!isObject(accounts)) return undefined;
  if (switchOn && !isObject(payer)) return undefined;
  const paidFrom = isObject(accounts.paidFrom)
    ? (accounts.paidFrom as unknown as AccountRef)
    : null;
  return {
    companyName: company.name,
    legalName: typeof company.legalName === 'string' ? company.legalName : null,
    payer: switchOn ? (payer as unknown as PayerState) : null,
    paidFrom,
  };
}

export function checkDocument(clock: Pick<Clock, 'now'>): Step {
  return ({ request, state }) => {
    const switchOn = request.input.paidPersonally === true;
    const context = contextOf(state, switchOn);
    if (!context) {
      return Promise.resolve(
        failedWith(WHAT, 'state_incomplete', CHECK_DOCUMENT_GUARDS.state_incomplete),
      );
    }
    const checked = checkFirstRead({
      answer: state.extraction,
      switchOn,
      ...context,
      today: utcDay(clock.now()),
    });
    if (checked.outcome === 'failed') {
      const { rule } = checked;
      return Promise.resolve(
        rule === 'answer_unusable'
          ? failedWith(WHAT, rule, CHECK_DOCUMENT_GUARDS.answer_unusable)
          : failedWith(WHAT, CHECK_DOCUMENT_REASONS[rule], CHECK_DOCUMENT_SENTENCES[rule]),
      );
    }
    // The raw answer leaves the state here: only the cleaned values travel on.
    const { extraction: _answer, ...kept } = state;
    return Promise.resolve({
      outcome: 'ok',
      summary: checkedSummary(checked.document, switchOn),
      state: { ...kept, document: checked.document as unknown as JsonObject },
    });
  };
}
