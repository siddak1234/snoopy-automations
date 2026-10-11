import type { JsonObject } from '@autom8x/automation-sdk';

import type { FileKind } from './file.js';
import type { SpendType } from './spend-types.js';

/**
 * The run's state between steps — this automation's own envelope, which a held run
 * hands back verbatim in its continuation.
 *
 * A step's returned state REPLACES the whole state (the SDK's runner), so every step
 * returns `{ ...state, <its key>: value }` and writes no other step's key. Bytes, links
 * and filenames never enter it: a held state travels to the platform and back.
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

/** `read-company`: the names kept for the checks that compare them later, and the payroll flag. */
export interface CompanyState {
  readonly name: string;
  readonly legalName: string | null;
  /** As QuickBooks returned it. */
  readonly country: string;
  /**
   * CompanyInfo's `PayrollFeature`: whether the company runs QuickBooks Payroll, for the note
   * that an employee is repaid through a Reimbursement pay item; null when it is not said.
   */
  readonly payrollFeature: boolean | null;
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

/** One QuickBooks account a setting names. */
export interface AccountRef {
  readonly id: string;
  /** As QuickBooks spells it. */
  readonly fullyQualifiedName: string;
  /** Intuit's AccountType: a Paid from account's decides the expense's payment type. */
  readonly accountType: string;
}

/** `find-accounts`: one account per role; an optional setting left empty is null. */
export interface AccountsState {
  readonly defaultCategory: AccountRef;
  /** Each category setting filled in, by its spend type; a type absent here uses the default. */
  readonly categories: Readonly<Partial<Record<SpendType, AccountRef>>>;
  readonly paidFrom: AccountRef | null;
  readonly teamOwed: AccountRef | null;
  readonly ownerInvestment: AccountRef | null;
  /** "Owners and partners", in order, each with their own account when the setting gives one. */
  readonly owners: readonly { readonly name: string; readonly account: AccountRef | null }[];
}

/**
 * `find-payer`, only when someone paid with their own money: an owner from this flow's
 * settings, an employee in QuickBooks, or neither yet — then find-vendor looks the name up
 * among vendors. Absent when the company paid.
 */
export interface PayerState {
  readonly route: 'owner' | 'employee' | 'not_employee';
  /** As the owner is written in the settings, as QuickBooks shows the employee, or as typed, cleaned. */
  readonly name: string;
  /** The employee's QuickBooks Id; null for an owner or a name that is not an employee. */
  readonly employeeId: string | null;
  /**
   * The account the purchase is owed or invested to: Owed to team members for an employee; the
   * owner's own account, or else Owner's investment; null for a name that is not an employee.
   */
  readonly account: AccountRef | null;
}

/**
 * `extract`: the model's answer, whole — the 27 fields of `prompts/extract-document.v1.json`,
 * held to its schema by the platform — kept only until the step that checks it replaces it
 * with the fields it cleans, so a held state never carries a line's raw text; and the model
 * that served, as the router reported it, which may differ from the id asked for.
 */
export interface ExtractionState {
  readonly extraction: JsonObject;
  readonly modelServed: string;
}
