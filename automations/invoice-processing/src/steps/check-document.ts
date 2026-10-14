import type { Clock } from '@autom8x/automation-kit/quickbooks';
import { capitalised, utcDay } from '@autom8x/automation-kit/values';
import {
  isObject,
  truncateText,
  type JsonObject,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { checkFirstRead } from '../checks/check.js';
import { namedFields } from '../checks/fields.js';
import { CHECK_DOCUMENT_REASONS, RECORDING_RULES } from '../checks/rules.js';
import { runFails } from '../outcome.js';
import { notRecorded, onQuickBooksPath } from '../quickbooks-path.js';
import type { DocumentState, Finding } from '../state.js';
import { LINE_MAXIMUM } from '../words.js';

/**
 * `check-document` (code only) — the first read cleaned once, routed, and held to the rules (the
 * plan's §2.1–§2.5; v2's §2.6). On either path, a document that cannot be used ends the run here
 * with one plain sentence, before anything else is spent. On the QuickBooks path, a document
 * QuickBooks cannot record is "not recorded in QuickBooks": the run goes on, and its details are
 * saved. Otherwise it goes on with its clean values, its route and what it found, in
 * `state.document`. The raw answer leaves the state here, so no line item, no word printed beside
 * one, ever travels further.
 */

/** What check-document found, as its line and decide's hold phrases say it (§2.6). */
export const FINDING_WORDS: Readonly<Record<Finding, (document: DocumentState) => string>> = {
  lists_other_invoices: () => 'may be a statement',
  earlier_balance: () => 'earlier balance also due',
  refund_method_not_shown: () => 'refund method not shown',
  tip_added: () => 'tip added to the total',
  amounts_mismatch: () => "totals don't add up",
  unclear_fields: (document) => `unclear: ${namedFields(document.unclearFields)}`,
  not_cross_checked: () => 'total not checked',
  currency_unrecognised: () => 'currency not recognised',
};

/** The timeline line (§3.E): `Checks passed`, or what was found, joined by commas. */
export function checkedSummary(document: DocumentState): string {
  if (document.findings.length === 0) return 'Checks passed';
  const found = document.findings.map((finding) => FINDING_WORDS[finding](document));
  return truncateText(capitalised(found.join(', ')), LINE_MAXIMUM);
}

/** The company's names as C10 reads them, on the QuickBooks path; undefined when missing. */
function companyOf(state: JsonObject): { name: string; legalName: string | null } | undefined {
  const { company } = state;
  if (!isObject(company) || typeof company.name !== 'string') return undefined;
  return {
    name: company.name,
    legalName: typeof company.legalName === 'string' ? company.legalName : null,
  };
}

export function checkDocument(clock: Pick<Clock, 'now'>): Step {
  return ({ request, state }) => Promise.resolve(checked(request, state, clock));
}

function checked(
  request: Parameters<typeof onQuickBooksPath>[0],
  state: JsonObject,
  clock: Pick<Clock, 'now'>,
): StepResult {
  const quickBooks = onQuickBooksPath(request, state);
  const company = quickBooks ? companyOf(state) : { name: null, legalName: null };
  // read-company keeps the company on the QuickBooks path: a guard that should never fire.
  if (!company) return runFails('other', 'state_incomplete');
  const outcome = checkFirstRead({
    answer: state.extraction,
    quickBooks,
    companyName: company.name,
    legalName: company.legalName,
    today: utcDay(clock.now()),
  });
  if (outcome.outcome === 'failed') {
    const { rule } = outcome;
    return rule === 'answer_unusable'
      ? runFails('unreadable', rule)
      : runFails(rule, CHECK_DOCUMENT_REASONS[rule]);
  }
  // The raw answer leaves the state here: only the cleaned values travel on.
  const { extraction: _answer, ...kept } = state;
  const next = { ...kept, document: outcome.document as unknown as JsonObject };
  if (outcome.recordingRule !== undefined) {
    return notRecorded(next, RECORDING_RULES[outcome.recordingRule], 'ok');
  }
  return { outcome: 'ok', summary: checkedSummary(outcome.document), state: next };
}
