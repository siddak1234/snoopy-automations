import { capitalised, cleanText, fitLine, formatMoney } from '@autom8x/automation-kit/values';
import {
  MAIL_BODY_MAX_LENGTH,
  MAIL_SUBJECT_MAX_LENGTH,
  truncateText,
} from '@autom8x/automation-sdk';

import type { SavedState } from '../decide/saved.js';
import type { StatementResult } from '../decide/statement.js';
import { NOUNS, nextStepOf, payeeNameOf } from './lines.js';
import type { CreatedState, NewVendorState } from './saved-state.js';

/**
 * notify's mail (the plan's §5, "notify, per type"; ip-review design-after-approval-writes-notify-
 * tests.json steps[5]): plain text, fixed labels, one value a line, built from what QuickBooks
 * answered and decide saved — never the model's answer, a line item, a hold reason, the file or a
 * link — and no timestamp, so the same run and key always give the same words, which the platform
 * turns into one mail however often the step runs. The subject names the vendor, the number and
 * the total (the design's open question, its recommended answer applied: the address is one the
 * owner typed for this, and the platform refuses one inside the workspace).
 */

export interface Mail {
  readonly subject: string;
  readonly body: string;
}

/** A value on one line: line breaks and control characters made spaces, trimmed. */
const value = (text: string | null | undefined) => cleanText(text) ?? '';

/** Intuit's warning (H5): a bank rule set to add a charge on its own leaves no review to match it in. */
export const BANK_RULE_NOTE =
  'A bank rule set to add matching charges automatically skips that review.';

function finished(subject: (string | { name: string })[], lines: readonly string[]): Mail {
  return {
    subject: fitLine(subject, MAIL_SUBJECT_MAX_LENGTH),
    body: truncateText(lines.join('\n'), MAIL_BODY_MAX_LENGTH),
  };
}

/** "a bill", "an expense". */
const withArticle = (noun: string) => `${/^[aeiou]/u.test(noun) ? 'an' : 'a'} ${noun}`;

/**
 * The mail for a record made: what it is in QuickBooks — its Id, the vendor it names, or the seller
 * when it names none (an expense with no payee, a journal entry) or names the person who paid (a
 * contractor's bill) — who paid, its number (from QuickBooks, else the document's, kept in the
 * memo), date, total and due date as QuickBooks answered them, and the next step.
 */
export function recordMail(
  saved: SavedState,
  created: CreatedState,
  newVendor: NewVendorState | null,
  decidedBy: 'automatically' | 'after approval',
): Mail {
  const { plan } = saved;
  const noun = NOUNS[plan.record];
  const person =
    saved.route === 'employee' || saved.route === 'owner' || saved.route === 'contractor';
  const vendorNamed = plan.payee.kind === 'vendor' || plan.payee.kind === 'new_vendor';
  const vendor = vendorNamed ? value(payeeNameOf(saved, created, newVendor)) : null;
  const seller = value(saved.seller);
  const total = formatMoney(created.totalCents ?? plan.amountCents);
  const sentNumber = created.docNumber ?? plan.docNumber;
  const number = sentNumber ?? saved.documentNumber;
  const next = nextStepOf(saved);
  const lines = [
    `${capitalised(withArticle(noun))} was recorded in your QuickBooks Online company by Autom8x Bills & Receipts.`,
    '',
    `${capitalised(noun)} in QuickBooks: ${value(created.id)}`,
    ...(vendor === null ? [] : [`Vendor: ${vendor}`]),
    ...(vendor === null || saved.route === 'contractor' ? [`Seller: ${seller}`] : []),
    ...(person ? [`Paid by: ${value(saved.payer?.name)}`] : []),
    ...(number === null
      ? []
      : [`Number: ${value(number)}${sentNumber === null ? ' (in the memo)' : ''}`]),
    `Date: ${created.txnDate}`,
    `Total: ${total}`,
    ...(saved.route === 'bill' ? [`Due date: ${created.dueDate ?? 'not set'}`] : []),
    ...(plan.accounts.paidFrom === null
      ? []
      : [`Paid from: ${value(plan.accounts.paidFrom.name)}`]),
    `Category: ${value(plan.accounts.category.name)}`,
    `Decided: ${decidedBy}`,
    ...(next === null ? [] : ['', `Next step: ${next}`]),
    ...(saved.route === 'company_receipt' || saved.route === 'card_refund' ? [BANK_RULE_NOTE] : []),
  ];
  const subject = [
    `${capitalised(noun)} ${value(created.id)} recorded in QuickBooks: `,
    { name: vendor ?? seller },
    `${number === null ? '' : `, ${value(number)}`}, ${total}`,
  ];
  return finished(subject, lines);
}

const counted = (count: number, checkable: boolean) =>
  `${count}${checkable ? '' : ' (too many to check)'}`;

/**
 * The mail for a statement compared: the counts and what QuickBooks shows open for the vendor. The
 * statement's own figures and the invoice numbers stay in the run's timeline and output.
 */
export function statementMail(result: StatementResult): Mail {
  const vendor = value(result.vendor.displayName);
  const open = result.openBillsNotListed;
  const lines = [
    "A supplier's statement was compared with your QuickBooks Online company by Autom8x Bills & Receipts. Nothing was recorded.",
    '',
    `Vendor: ${vendor}`,
    `Invoices it lists that are not in QuickBooks: ${counted(result.listedNotInQuickBooks.length, result.listedCheckable)}`,
    open === null
      ? 'Open bills in QuickBooks it does not list: not compared, as its list is not complete'
      : `Open bills in QuickBooks it does not list: ${counted(open.count, result.openBillsCheckable)}`,
    `QuickBooks shows open for this vendor: ${
      result.quickBooksOpenCents === null ? 'not shown' : formatMoney(result.quickBooksOpenCents)
    }`,
    '',
    "The statement's own figures and the invoice numbers are in the run's timeline in Autom8x.",
  ];
  return finished(['Statement from ', { name: vendor }, ' compared with QuickBooks'], lines);
}
