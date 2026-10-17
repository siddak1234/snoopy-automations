import { TRANSACTION_ENTITIES } from '@autom8x/automation-kit/quickbooks';
import { MAXIMUM_CENTS } from '@autom8x/automation-kit/values';
import { isObject, type JsonObject } from '@autom8x/automation-sdk';

import type { RecordRoute } from '../decide/duplicate-rule.js';
import { HOLD_ORDER } from '../decide/holds.js';
import type { Payee, RecordPlan } from '../decide/plan.js';
import type { SavedState } from '../decide/saved.js';
import type { StatementResult } from '../decide/statement.js';
import { KEPT_TYPES, PAYMENT_METHODS, REFUND_METHODS, ROUTES } from '../document.js';

/**
 * The run's state after decide, as the steps after it read it (the plan's §2.8): decide's saved data —
 * the ONLY input of the writes, held or straight through — and the two keys the steps after it
 * add: `newVendor`, the vendor a bill's new name turned out to be (found while the run waited, or
 * created after the approval), and `created`, the record as QuickBooks answered it. A held state
 * comes back from the platform verbatim, so each step reads it whole first and, when anything it
 * needs is missing or malformed, ends with "could not finish its checks" before any QuickBooks
 * call (the design's held-state guard).
 */

/** The vendor a planned new vendor became: found under its name while the run waited, or added. */
export interface NewVendorState {
  readonly how: 'found' | 'created';
  readonly id: string;
  /** As QuickBooks shows it. */
  readonly displayName: string;
}

/** The record create-record made, as QuickBooks answered it (`src/steps/create-record.ts`). */
export interface CreatedState {
  readonly record: RecordPlan['record'];
  readonly id: string;
  /** QuickBooks' `DocNumber`, else the number sent, else none. */
  readonly docNumber: string | null;
  /** QuickBooks' `TxnDate`, else the date sent. */
  readonly txnDate: string;
  /** A bill's `DueDate` as QuickBooks set it; null on any other record. */
  readonly dueDate: string | null;
  /** QuickBooks' `TotalAmt` in cents; null when it gave none usable. */
  readonly totalCents: number | null;
  /** The payee as QuickBooks names it on the record (`VendorRef.name`, `EntityRef.name`), if it does. */
  readonly payeeName: string | null;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown) => value === null || isText(value);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const isIds = (value: unknown) => Array.isArray(value) && value.every(isText);
const isAccount = (value: unknown) => isObject(value) && isText(value.id) && isText(value.name);
const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_CENTS;
const among = (list: readonly unknown[], value: unknown) => list.includes(value);

/** What each route records: its operation, its record, the payees it may name, whether it is paid from an account. */
const SHAPES: Readonly<
  Record<
    RecordRoute,
    {
      readonly operation: RecordPlan['operation'];
      readonly record: RecordPlan['record'];
      readonly payees: readonly Payee['kind'][];
      readonly paidFrom: boolean;
    }
  >
> = {
  bill: {
    operation: 'bill.create',
    record: 'bill',
    payees: ['vendor', 'new_vendor'],
    paidFrom: false,
  },
  company_receipt: {
    operation: 'purchase.create',
    record: 'expense',
    payees: ['vendor', 'new_vendor', 'none'],
    paidFrom: true,
  },
  card_refund: {
    operation: 'purchase.create',
    record: 'card_refund',
    payees: ['vendor', 'new_vendor', 'none'],
    paidFrom: true,
  },
  vendor_credit: {
    operation: 'vendorCredit.create',
    record: 'vendor_credit',
    payees: ['vendor'],
    paidFrom: false,
  },
};

function isPayee(value: unknown, kinds: readonly Payee['kind'][]): boolean {
  if (!isObject(value) || !among(kinds, value.kind)) return false;
  switch (value.kind) {
    case 'vendor':
      return isText(value.id) && isText(value.name);
    case 'new_vendor':
      return (
        isText(value.name) &&
        isText(value.printedName) &&
        among(['customer', 'employee', null], value.nameInUseBy)
      );
    default:
      return true;
  }
}

function isPlan(value: unknown, route: RecordRoute): boolean {
  const shape = SHAPES[route];
  if (!isObject(value) || !isObject(value.accounts)) return false;
  const { accounts } = value;
  const purchase = shape.operation === 'purchase.create';
  const check = value.paymentType === 'Check';
  return (
    value.operation === shape.operation &&
    value.record === shape.record &&
    (purchase
      ? among(['Cash', 'Check', 'CreditCard'], value.paymentType)
      : value.paymentType === null) &&
    value.credit === (route === 'card_refund') &&
    (route !== 'card_refund' || value.paymentType === 'CreditCard') &&
    value.printStatus === (check ? 'NotSet' : null) &&
    isAccount(accounts.category) &&
    typeof (accounts.category as JsonObject).why === 'string' &&
    (shape.paidFrom ? isAccount(accounts.paidFrom) : accounts.paidFrom === null) &&
    isPayee(value.payee, shape.payees) &&
    isCents(value.amountCents) &&
    isDay(value.date) &&
    (value.dueDate === null || isDay(value.dueDate)) &&
    (value.docNumber === null || (isText(value.docNumber) && value.docNumber.length <= 21)) &&
    typeof value.memo === 'string' &&
    isText(value.lineDescription) &&
    among(['USD', null], value.currencyRef)
  );
}

function isRecheck(value: unknown, saved: JsonObject): boolean {
  if (!isObject(value) || !isObject(value.facts)) return false;
  const { facts } = value;
  return (
    among(['numberLookup', 'amountLookup'], value.lookup) &&
    among(TRANSACTION_ENTITIES, value.entity) &&
    typeof value.query === 'string' &&
    value.query.startsWith(`SELECT * FROM ${String(value.entity)} WHERE `) &&
    value.query.length <= 4_000 &&
    typeof value.maxResults === 'number' &&
    Number.isSafeInteger(value.maxResults) &&
    value.maxResults >= 1 &&
    value.maxResults <= 1_000 &&
    isTextOrNull(value.fullAt) &&
    facts.route === saved.route &&
    isTextOrNull(facts.number) &&
    isCents(facts.amountCents) &&
    isDay(facts.date) &&
    isTextOrNull(facts.vendorId) &&
    isTextOrNull(facts.accountId)
  );
}

/** The document as read, kept for the saved details (`src/details.ts`). */
function isRead(value: unknown): boolean {
  return (
    isObject(value) &&
    among(KEPT_TYPES, value.documentType) &&
    isText(value.seller) &&
    isTextOrNull(value.number) &&
    (value.date === null || isDay(value.date)) &&
    (value.dueDate === null || isDay(value.dueDate)) &&
    isTextOrNull(value.currency) &&
    (value.totalCents === null || Number.isSafeInteger(value.totalCents)) &&
    (value.taxCents === null || Number.isSafeInteger(value.taxCents)) &&
    typeof value.spendType === 'string' &&
    among(PAYMENT_METHODS, value.paymentMethod) &&
    isTextOrNull(value.cardLast4)
  );
}

/**
 * decide's saved data, read back whole — or undefined when anything the steps after decide read
 * is missing or malformed, a statement's comparison included (it saves nothing).
 */
export function readSaved(state: JsonObject): SavedState | undefined {
  const { plan, duplicates, company, preferences, modelServed, receipt, credit } = state;
  const route = state.route;
  if (state.v !== 2 || route === 'statement' || !among(ROUTES, route)) return undefined;
  const recorded = route as RecordRoute;
  const ok =
    among(KEPT_TYPES, state.documentType) &&
    state.documentType !== 'supplier_statement' &&
    isText(state.seller) &&
    isTextOrNull(state.documentNumber) &&
    isPlan(plan, recorded) &&
    isRead(state.read) &&
    (receipt === null || (isObject(receipt) && among(PAYMENT_METHODS, receipt.paymentMethod))) &&
    (credit === null || (isObject(credit) && among(REFUND_METHODS, credit.refundMethod))) &&
    isObject(duplicates) &&
    isIds(duplicates.billIds) &&
    isIds(duplicates.expenseIds) &&
    isIds(duplicates.vendorCreditIds) &&
    isIds(duplicates.journalEntryIds) &&
    typeof duplicates.docNumberLeftOut === 'boolean' &&
    isRecheck(state.recheck, state) &&
    Array.isArray(state.holdReasons) &&
    state.holdReasons.every((code) => among(HOLD_ORDER, code)) &&
    isObject(company) &&
    isText(company.name) &&
    isTextOrNull(company.legalName) &&
    typeof company.country === 'string' &&
    isTextOrNull(company.createdAt) &&
    isObject(preferences) &&
    isText(preferences.homeCurrency) &&
    typeof preferences.multiCurrencyEnabled === 'boolean' &&
    isText(state.artifactId) &&
    isObject(modelServed) &&
    isText(modelServed.first) &&
    isTextOrNull(modelServed.second);
  return ok ? (state as unknown as SavedState) : undefined;
}

/** decide's statement comparison, as its step left the state: a statement creates nothing. */
export function isStatementComparison(state: JsonObject): boolean {
  return (
    state.v === 2 &&
    state.route === 'statement' &&
    Array.isArray(state.listedNotInQuickBooks) &&
    isObject(state.vendor)
  );
}

/** The comparison, when the state is one. */
export const statementOf = (state: JsonObject): StatementResult | undefined =>
  isStatementComparison(state) ? (state as unknown as StatementResult) : undefined;

/** `state.newVendor`: absent until confirm-vendor finds the vendor or create-vendor adds it. */
export function newVendorOf(state: JsonObject): NewVendorState | null | undefined {
  const value = state.newVendor;
  if (value === undefined) return null;
  return isObject(value) &&
    among(['found', 'created'], value.how) &&
    isText(value.id) &&
    isText(value.displayName)
    ? (value as unknown as NewVendorState)
    : undefined;
}

/** `state.created`: absent until create-record made the record. */
export function createdOf(state: JsonObject): CreatedState | undefined {
  const value = state.created;
  return isObject(value) && isText(value.id) && typeof value.record === 'string'
    ? (value as unknown as CreatedState)
    : undefined;
}

/** Whether this run added the vendor: then every later failure says so (the recommended answer). */
export const vendorCreated = (state: JsonObject) => newVendorOf(state)?.how === 'created';
