import type { QuickBooksWriteKind } from '@autom8x/automation-kit/quickbooks';
import type { JsonObject } from '@autom8x/automation-sdk';

import type { Payee, RecordPlan } from '../decide/plan.js';

/**
 * The QuickBooks bodies the writes send (the plan's §2.6, §5 "Writes"; Intuit's create shapes), built
 * ONLY from decide's saved plan and the id of the run that writes — no clock, no setting, nothing
 * read again — so every copy of a step sends the same bytes, which the platform's record for the
 * step's key replays, and approval writes exactly what was approved (§2.8). The request id is the
 * platform's (it puts `requestid` on the URL), and no body names `Id`, `SyncToken` or `sparse`: a
 * create that named a record would update it, which the platform refuses (its 25.2.33).
 *
 * Left out on purpose, each an open point for the sandbox, never a blocker:
 * - `APAccountRef` on a bill and a vendor credit: QuickBooks' default A/P account (the design's
 *   open question, its recommended answer applied: none in v1; sandbox to confirm; an optional A/P
 *   setting later if a company needs another);
 * - `TxnTaxDetail`, `GlobalTaxCalculation` (US companies only), `SalesTermRef` (terms already gave
 *   the due date), line Ids, `TotalAmt` (QuickBooks computes it), an attachment (D29: none in v1).
 *
 * Sandbox points the bodies rest on: S2 (the account types an expense line takes), S3 (Cash for a
 * debit card or transfer from a bank account), S8 (a check expense with print status "NotSet"),
 * S13 (CurrencyRef USD with multicurrency on).
 */

/** The memo's first sentence (v2: "Invoice Processing"): the run that writes the record — after an approval, the continuation. */
export function runLine(runId: string): string {
  return `Created by Autom8x Invoice Processing, run ${runId}.`;
}

/** The memo QuickBooks keeps: the run that wrote it, then the plan's words. */
export function memoOf(plan: RecordPlan, runId: string): string {
  return plan.memo === '' ? runLine(runId) : `${runLine(runId)} ${plan.memo}`;
}

/** Whole cents as QuickBooks' amount: integer cents over 100, which JSON prints exactly. */
const amountOf = (cents: number) => cents / 100;

/** One account-based expense line: the whole amount to the category (D27; the plan's one line). */
function expenseLine(plan: RecordPlan): JsonObject {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: amountOf(plan.amountCents),
    Description: plan.lineDescription,
    AccountBasedExpenseLineDetail: { AccountRef: { value: plan.accounts.category.id } },
  };
}

/** CurrencyRef USD when the company has multicurrency on (sandbox S13); nothing otherwise. */
const currencyOf = (plan: RecordPlan): JsonObject =>
  plan.currencyRef === null ? {} : { CurrencyRef: { value: plan.currencyRef } };

/** Which of the kit's writes a plan's operation is. */
export function writeKindOf(plan: RecordPlan): QuickBooksWriteKind {
  switch (plan.operation) {
    case 'bill.create':
      return 'bill';
    case 'purchase.create':
      return 'expense';
    case 'vendorCredit.create':
      return 'vendorCredit';
  }
}

/**
 * The record's body. `vendorId` is the vendor it names: the plan's own, or — for a bill's new
 * vendor — the one confirm-vendor found or create-vendor added; null when it names none.
 */
export function recordBody(plan: RecordPlan, vendorId: string | null, runId: string): JsonObject {
  const memo = memoOf(plan, runId);
  switch (plan.operation) {
    case 'bill.create':
      return {
        VendorRef: { value: vendorId ?? '' },
        TxnDate: plan.date,
        ...(plan.dueDate === null ? {} : { DueDate: plan.dueDate }),
        ...(plan.docNumber === null ? {} : { DocNumber: plan.docNumber }),
        PrivateNote: memo,
        ...currencyOf(plan),
        Line: [expenseLine(plan)],
      };
    case 'purchase.create':
      return {
        PaymentType: plan.paymentType ?? 'Cash',
        AccountRef: { value: plan.accounts.paidFrom?.id ?? '' },
        TxnDate: plan.date,
        // The payee only when the seller is already a vendor (D20).
        ...(vendorId === null ? {} : { EntityRef: { value: vendorId, type: 'Vendor' } }),
        // A refund to the card: "Credit card credit" (I2).
        ...(plan.credit ? { Credit: true } : {}),
        // A check's print status said outright, NotSet: accepted, and the API's own default in the
        // sandbox too (I2; sandbox S8).
        ...(plan.printStatus === null ? {} : { PrintStatus: plan.printStatus }),
        PrivateNote: memo,
        ...currencyOf(plan),
        Line: [expenseLine(plan)],
      };
    case 'vendorCredit.create':
      return {
        VendorRef: { value: vendorId ?? '' },
        TxnDate: plan.date,
        // Only with the own-numbers setting on (I3): decide left it null otherwise.
        ...(plan.docNumber === null ? {} : { DocNumber: plan.docNumber }),
        PrivateNote: memo,
        ...currencyOf(plan),
        Line: [expenseLine(plan)],
      };
  }
}

/**
 * QuickBooks' bound on a vendor's company name, 100 characters ("Max:100"), which also caps the
 * check name sent here. The check name's own bound is 110 ("Max:110", sandbox G4–5), but this one
 * number decides when a company name is sent at all, and one of 101–110 characters is refused.
 */
const NAME_ON_CHECK_LENGTH = 100;

/** `text` in at most `maximum` whole characters — never half of one — with no space left at the end. */
function cut(text: string, maximum: number): string {
  return [...text].slice(0, maximum).join('').trimEnd();
}

/**
 * The new vendor's body: the name the approver saw (`DisplayName`), its printed name as its
 * company name when that fits QuickBooks' 100 characters — so the next document from a "(vendor)"
 * supplier matches find-vendor-company — and nothing from the document beyond the name: no
 * address, email, phone or tax id. With a display name past 100 characters, `PrintOnCheckName` —
 * which QuickBooks fills from the display name when none is sent, cutting it to 110 itself, and
 * refuses past 110 (sandbox G4–5) — is the printed name cut to 100 whole characters (the design's
 * open question, its recommended answer applied; accepted as sent in the sandbox). No
 * `CurrencyRef`: the home currency.
 */
export function vendorBody(payee: Extract<Payee, { kind: 'new_vendor' }>): JsonObject {
  const printed = [...payee.printedName].length;
  return {
    DisplayName: payee.name,
    ...(printed <= NAME_ON_CHECK_LENGTH ? { CompanyName: payee.printedName } : {}),
    ...([...payee.name].length > NAME_ON_CHECK_LENGTH
      ? { PrintOnCheckName: cut(payee.printedName, NAME_ON_CHECK_LENGTH) }
      : {}),
  };
}
