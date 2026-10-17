import type { CreditSigns, TipOutcome } from '@autom8x/automation-kit/values';

import type { KeptType, ListedKind, PaymentMethod, RefundMethod, Route } from './document.js';
import type { FileKind } from './file.js';
import type { SpendType } from './spend-types.js';

/**
 * The run's state between steps — this automation's own envelope, which a held run
 * hands back verbatim in its continuation.
 *
 * A step's returned state REPLACES the whole state (the SDK's runner), so every step
 * returns `{ ...state, <its key>: value }` and writes no other step's key — with these
 * exceptions: `check-document` drops `extraction`, the raw answer, once it has cleaned it;
 * `verify-read` re-derives `document` when its tie-break records the second read's total (Group
 * 3's D9); `decide` drops `chart` once the plan is made; and any QuickBooks step may set
 * `quickBooks` (`src/quickbooks-path.ts`) when QuickBooks will not record this document. Bytes,
 * links and filenames never enter it: a held state travels to the platform and back.
 */

/** `receive`: the file, as the platform measured it. */
export interface FileState {
  readonly artifactId: string;
  readonly kind: FileKind;
  readonly sizeBytes: number;
  /** A PDF's pages; null for an image. */
  readonly pages: number | null;
  /** The store's digest of the bytes, when it gave one. */
  readonly sha256: string | null;
}

/** `read-company`: the names kept for the checks that compare them later. */
export interface CompanyState {
  readonly name: string;
  readonly legalName: string | null;
  /** As QuickBooks returned it. */
  readonly country: string;
  /**
   * CompanyInfo's `MetaData.CreateTime`: when the company file was created, from the same answer,
   * so confirm-company can tell two companies with the same names apart after an approval (the
   * design's open question, its recommended answer applied); null when QuickBooks does not say.
   */
  readonly createdAt: string | null;
}

/** `read-preferences`: the settings later steps read. */
export interface PreferencesState {
  readonly homeCurrency: string;
  readonly multiCurrencyEnabled: boolean;
  /** `SalesFormsPrefs.CustomTxnNumbers`: the sales side's own-numbers setting. */
  readonly customTxnNumbers: boolean | null;
  /**
   * OtherPrefs' `VendorAndPurchasesPrefs.UseCustomTxnNumbers`: whether a vendor credit may be
   * sent its own number — Intuit's advice is to check it first; null when QuickBooks does not
   * say (whether it does is a sandbox question).
   */
  readonly purchaseCustomTxnNumbers: boolean | null;
  readonly warnDuplicateBillNumber: boolean | null;
  /** The books' closing date, `YYYY-MM-DD`, when QuickBooks returned a real one. */
  readonly bookCloseDate: string | null;
}

/** How one arithmetic check ended: within 1¢, off by more, or not possible with what is printed. */
export type CheckResult = 'passed' | 'missed' | 'not_run';

/**
 * `check-document`'s arithmetic (the plan's §2.5): the parts in whole cents as cleaned — after the
 * credit sign rule — and the lines' sum, kept so the second read's re-check can run again
 * (Group 3's D9); never a line or its text.
 */
export interface ArithmeticState {
  readonly subtotalCents: number | null;
  readonly taxCents: number | null;
  readonly shippingCents: number | null;
  readonly discountCents: number | null;
  /** The lines' sum, only when they can be added: complete, 1 to 40 of them, each with an amount. */
  readonly linesCents: number | null;
  /** A credit note's sign rule; null on any other document. */
  readonly signs: CreditSigns | null;
  /** Subtotal, tax, shipping and any tip, less the discount, against the total. */
  readonly parts: CheckResult;
  /** The lines against the subtotal, or with none printed against the total less the other parts. */
  readonly lines: CheckResult;
}

/** One row a supplier's statement lists, cleaned: a reference like a document number, whole cents. */
export interface StatementRow {
  readonly reference: string;
  readonly amountCents: number;
  readonly kind: ListedKind;
}

/** A supplier's statement as read (the plan's §2.2): at most 40 rows, which leave the state at decide. */
export interface StatementState {
  readonly rows: readonly StatementRow[];
  /** The model listed every row, and none was dropped in cleaning. */
  readonly complete: boolean;
  /** (a) balance forward + invoices − payments − credits, when the list is complete. */
  readonly ownSumCents: number | null;
}

/** What `check-document` finds for `decide` to turn into holds (the plan's §2.4). */
export type Finding =
  | 'amounts_mismatch'
  | 'not_cross_checked'
  | 'unclear_fields'
  | 'currency_unrecognised'
  | 'tip_added'
  | 'earlier_balance'
  | 'refund_method_not_shown'
  | 'lists_other_invoices';

/**
 * `check-document` (the plan's §2.1, §2.2, §2.5): the first read cleaned once — every later step
 * uses only these values — the route it takes, and what it found. The raw answer, line items and
 * every word printed beside them are gone.
 */
export interface DocumentState {
  readonly type: KeptType;
  readonly route: Route;
  /** The seller as printed, cleaned: at most 500 characters. */
  readonly seller: string;
  /** A web or e-mail address in the seller's name (D4): a note on the line, not a hold. */
  readonly sellerHasWebAddress: boolean;
  /** The document's own number, cleaned: at most 100 characters. */
  readonly number: string | null;
  /** 1–21 characters: what QuickBooks takes as a bill's or a vendor credit's own number. */
  readonly numberUsable: boolean;
  /** Its date; null only on a statement, which needs none. */
  readonly date: string | null;
  /** A bill's due date: printed, else its date plus the printed terms, else none. */
  readonly dueDate: string | null;
  readonly dueDateSource: 'printed' | 'terms' | 'none';
  /** A printed due date the printed terms do not give: the printed date wins. */
  readonly termsDiffer: boolean;
  /** A printed ISO 4217 code; null when none is printed or it is not recognised. */
  readonly currency: string | null;
  readonly currencyUnrecognised: boolean;
  /** The total as printed, after the credit sign rule; null only on a statement with no balance. */
  readonly totalCents: number | null;
  /** What the record carries: the total, plus a tip code added (hold 12); null on a statement. */
  readonly amountCents: number | null;
  readonly amountDueCents: number | null;
  /** A bill whose amount due is larger than its charges: the difference (D24, hold 10). */
  readonly earlierBalanceCents: number | null;
  readonly tipCents: number | null;
  readonly tip: TipOutcome;
  readonly paymentMethod: PaymentMethod;
  /** Exactly four digits, or null. */
  readonly cardLast4: string | null;
  /** Card digits printed but not four digits: unclear, never compared. */
  readonly cardDigitsUnclear: boolean;
  readonly cashBackPrinted: boolean;
  readonly refundMethod: RefundMethod;
  readonly originalInvoiceNumber: string | null;
  readonly spendType: SpendType;
  /** The first read listed the spend type as unclear: Uncategorized Expense is used (§2.5). */
  readonly spendTypeUnclear: boolean;
  /** The earlier invoices a bill lists (hold 5); the rows themselves are dropped. */
  readonly listedInvoiceCount: number;
  /** A supplier's statement's rows; null on any other document. */
  readonly statement: StatementState | null;
  readonly arithmetic: ArithmeticState;
  readonly findings: readonly Finding[];
  /** The unclear fields, by their names in the answer, in display order (`FIELD_WORDS` words them). */
  readonly unclearFields: readonly string[];
}

/** The fields the second read compares (the plan's §4, verify-read). */
export type ComparedField =
  | 'documentType'
  | 'vendorName'
  | 'documentNumber'
  | 'documentDate'
  | 'currency'
  | 'total'
  | 'dueDate'
  | 'amountDue'
  | 'paymentMethod'
  | 'cardLast4'
  | 'cashBackPrinted'
  | 'refundMethod'
  | 'spendType';

/** Where the two reads part, each value as a person reads it. */
export interface Difference {
  readonly field: ComparedField;
  readonly first: string;
  readonly second: string;
}

/** Why the second read was not made, as one word for the timeline. */
export type NotMadeReason =
  | 'no_other_maker'
  | 'no_model_left'
  | 'same_maker'
  | 'answer_unusable'
  | 'content_filtered'
  | 'no_answer'
  | 'allowance_used'
  | 'plan_without_model_calls'
  | 'plan_check_unavailable';

/**
 * `verify-read` (the plan's §4; Group 2's D1–D6): the second, blind read by another maker, and
 * where it parts from the first — made ONLY when the first read shows a problem (the session's
 * decision 3, approved in advance, `secondReadDue`). Spend type is never a difference: a dispute
 * uses Uncategorized Expense (§2.5). Due and not made, the run holds on the QuickBooks path —
 * "second read not made" (D6). Not due, there is none: `{ status: 'not_needed' }`, which is also
 * what an absent key means, since a skipped step writes no state.
 */
export type VerificationState =
  | {
      readonly status: 'made';
      /** The model that served the second read: by another maker than the first. */
      readonly modelServed: string;
      readonly compared: readonly ComparedField[];
      readonly differences: readonly Difference[];
      /** When the totals differ, which one the arithmetic tie-break records (D4, D9). */
      readonly totalPicked: 'first' | 'second' | null;
      readonly spendTypeDisputed: boolean;
    }
  | { readonly status: 'not_made'; readonly reason: NotMadeReason }
  | { readonly status: 'not_needed' };
