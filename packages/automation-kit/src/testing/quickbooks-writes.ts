import type { JsonObject, ProviderAnswer } from '@autom8x/automation-sdk';

import { nameValueOf } from '../quickbooks/answers.js';
import {
  TIME,
  TODAY,
  faultAnswer,
  readAnswer,
  type SimulatedCompany,
} from './quickbooks-company.js';

/**
 * QuickBooks creating a vendor (`vendor.create`), a bill (`bill.create`), an expense
 * (`purchase.create`), a vendor credit (`vendorCredit.create`) or a journal entry
 * (`journalEntry.create`) in the made-up company — the writes the platform declares (its
 * `providers/quickbooks.json`; the plan's P1–P3). Only what Intuit documents: the required
 * fields (Fault 2020), a reference to an account or a vendor the company does not hold (2500)
 * or a vendor made inactive (610), a negative line (2290), a journal entry with no lines (2250),
 * a line with no posting type (2260) or debits unequal to credits (2300), a value longer than
 * its field holds (2050: a bill's number past 21 characters; a vendor's display name past 500,
 * its company name or check name past 100), a vendor's display name another vendor, customer or
 * employee already has (6240, compared without case); the record answered as
 * `{ <Entity>: {…}, time }`, its Id assigned, its `TotalAmt` the sum of its lines — a
 * journal entry's always 0, as Intuit's model says — a bill's `DueDate` its date when none is
 * sent, as Intuit's create sample answers, a vendor active in the home currency with its check
 * name its display name when none is sent, an expense or a vendor credit sent no number numbered by
 * QuickBooks itself when the company's own numbers are off, and kept, so a later query finds it.
 *
 * What only the sandbox can settle is not imitated: whether a payment type must match
 * its account's type, whether multicurrency makes `CurrencyRef` required (S13), whether a
 * journal entry's line may name an employee (S5), how a closed period refuses a record, or
 * whether a number is unique per vendor or company-wide (6140): a suite scripts those Faults.
 */

type Fault = '610' | '2020' | '2050' | '2250' | '2260' | '2290' | '2300' | '2500' | '6240';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refValue(value: unknown): string | undefined {
  return isObject(value) && typeof value.value === 'string' ? value.value : undefined;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/** The next Id among `rows`: one past the highest, from 1001. */
function nextId(rows: readonly JsonObject[]): string {
  const ids = rows.map((row) => Number(row.Id)).filter(Number.isSafeInteger);
  return String(Math.max(1000, ...ids) + 1);
}

/** Each line's amount in cents, or the Fault the lines earn. `detail` names each line's detail object. */
function linesOf(
  company: SimulatedCompany,
  lines: unknown,
  detail: string,
): { amounts: number[]; details: JsonObject[] } | Fault {
  if (!Array.isArray(lines) || lines.length === 0) return '2020';
  const amounts: number[] = [];
  const details: JsonObject[] = [];
  for (const line of lines) {
    if (!isObject(line) || typeof line.Amount !== 'number' || !isObject(line[detail])) {
      return '2020';
    }
    if (line.Amount < 0) return '2290';
    const account = refValue((line[detail] as JsonObject).AccountRef);
    if (account === undefined) return '2020';
    if (!company.accounts.some((row) => row.Id === account)) return '2500';
    amounts.push(cents(line.Amount));
    details.push(line[detail] as JsonObject);
  }
  return { amounts, details };
}

function created(
  rows: JsonObject[],
  entity: string,
  input: JsonObject,
  fields: JsonObject,
  company: SimulatedCompany,
): ProviderAnswer {
  const home = isObject(company.preferences.CurrencyPrefs)
    ? refValue(company.preferences.CurrencyPrefs.HomeCurrency)
    : undefined;
  const record: JsonObject = {
    ...structuredClone(input),
    TxnDate: typeof input.TxnDate === 'string' ? input.TxnDate : TODAY,
    CurrencyRef: isObject(input.CurrencyRef) ? input.CurrencyRef : { value: home ?? 'USD' },
    ...fields,
    Id: nextId(rows),
    SyncToken: '0',
    domain: 'QBO',
    sparse: false,
    MetaData: { CreateTime: TIME, LastUpdatedTime: TIME },
  };
  rows.push(record);
  return { status: 200, body: readAnswer(entity, record) };
}

const refused = (code: Fault): ProviderAnswer => ({ status: 400, body: faultAnswer(code) });

/** Intuit's bounds on the fields a create may send ("Maximum of N chars"). */
const LENGTHS = { docNumber: 21, displayName: 500, companyName: 100, printOnCheckName: 100 };

const longer = (value: unknown, maximum: number) =>
  typeof value === 'string' && [...value].length > maximum;

/** A vendor's name taken by a vendor, a customer or an employee: QuickBooks compares display names. */
function nameTaken(company: SimulatedCompany, name: string): boolean {
  const folded = name.trim().toLowerCase();
  return [...company.vendors, ...company.customers, ...company.employees].some(
    (row) => typeof row.DisplayName === 'string' && row.DisplayName.trim().toLowerCase() === folded,
  );
}

function createVendor(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  const name = input.DisplayName;
  if (typeof name !== 'string' || name.trim() === '') return refused('2020');
  if (
    longer(name, LENGTHS.displayName) ||
    longer(input.CompanyName, LENGTHS.companyName) ||
    longer(input.PrintOnCheckName, LENGTHS.printOnCheckName)
  ) {
    return refused('2050');
  }
  if (nameTaken(company, name)) return refused('6240');
  const home = isObject(company.preferences.CurrencyPrefs)
    ? refValue(company.preferences.CurrencyPrefs.HomeCurrency)
    : undefined;
  const record: JsonObject = {
    ...structuredClone(input),
    PrintOnCheckName: typeof input.PrintOnCheckName === 'string' ? input.PrintOnCheckName : name,
    Active: true,
    Balance: 0,
    Vendor1099: false,
    CurrencyRef: { value: home ?? 'USD' },
    Id: nextId(company.vendors),
    SyncToken: '0',
    domain: 'QBO',
    sparse: false,
    MetaData: { CreateTime: TIME, LastUpdatedTime: TIME },
  };
  company.vendors.push(record);
  return { status: 200, body: readAnswer('Vendor', record) };
}

/** The vendor a bill names, or the Fault: none named, one the company does not hold, one inactive. */
function vendorOf(company: SimulatedCompany, input: JsonObject): JsonObject | Fault {
  const id = refValue(input.VendorRef);
  if (id === undefined) return '2020';
  const vendor = company.vendors.find((row) => row.Id === id);
  if (!vendor) return '2500';
  return vendor.Active === false ? '610' : vendor;
}

function createBill(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  const vendor = vendorOf(company, input);
  if (typeof vendor === 'string') return refused(vendor);
  if (longer(input.DocNumber, LENGTHS.docNumber)) return refused('2050');
  const lines = linesOf(company, input.Line, 'AccountBasedExpenseLineDetail');
  if (typeof lines === 'string') return refused(lines);
  const total = lines.amounts.reduce((sum, each) => sum + each, 0) / 100;
  const date = typeof input.TxnDate === 'string' ? input.TxnDate : TODAY;
  return created(
    company.bills,
    'Bill',
    input,
    {
      VendorRef: { value: String(vendor.Id), name: String(vendor.DisplayName) },
      DueDate: typeof input.DueDate === 'string' ? input.DueDate : date,
      TotalAmt: total,
      Balance: total,
    },
    company,
  );
}

/**
 * Whether QuickBooks numbers an expense or a vendor credit sent none: Intuit's model says, of both,
 * "If VendorAndPurchasesPrefs.UseCustomTxnNumbers is false, resulting DocNumber is system generated
 * by incrementing the last number by 1" — so only when the company says false. Its own samples
 * name no such setting and answer no number, so a company that says nothing gets none.
 */
function numbersItself(company: SimulatedCompany, input: JsonObject): boolean {
  if (typeof input.DocNumber === 'string') return false;
  const prefs = company.preferences.OtherPrefs;
  const setting = nameValueOf(
    isObject(prefs) ? prefs.NameValue : undefined,
    'VendorAndPurchasesPrefs.UseCustomTxnNumbers',
  );
  return setting === 'false';
}

/** QuickBooks' own next number among `rows`: the last of digits alone, plus 1; 1 for the first. */
function nextNumber(rows: readonly JsonObject[]): string {
  const numbers = rows
    .map((row) => row.DocNumber)
    .filter((value): value is string => typeof value === 'string' && /^\d{1,15}$/u.test(value))
    .map(Number);
  return String(Math.max(0, ...numbers) + 1);
}

function createPurchase(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  if (typeof input.PaymentType !== 'string' || refValue(input.AccountRef) === undefined) {
    return refused('2020');
  }
  if (!company.accounts.some((row) => row.Id === refValue(input.AccountRef))) {
    return refused('2500');
  }
  const lines = linesOf(company, input.Line, 'AccountBasedExpenseLineDetail');
  if (typeof lines === 'string') return refused(lines);
  const total = lines.amounts.reduce((sum, each) => sum + each, 0) / 100;
  const numbered = numbersItself(company, input)
    ? { DocNumber: nextNumber(company.purchases) }
    : {};
  return created(company.purchases, 'Purchase', input, { TotalAmt: total, ...numbered }, company);
}

function createVendorCredit(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  // A vendor credit names its vendor as a bill does ("The vendor reference for this transaction").
  const vendor = vendorOf(company, input);
  if (typeof vendor === 'string') return refused(vendor);
  if (longer(input.DocNumber, LENGTHS.docNumber)) return refused('2050');
  const lines = linesOf(company, input.Line, 'AccountBasedExpenseLineDetail');
  if (typeof lines === 'string') return refused(lines);
  const total = lines.amounts.reduce((sum, each) => sum + each, 0) / 100;
  return created(
    company.vendorCredits,
    'VendorCredit',
    input,
    {
      VendorRef: { value: String(vendor.Id), name: String(vendor.DisplayName) },
      TotalAmt: total,
      Balance: total,
      ...(numbersItself(company, input) ? { DocNumber: nextNumber(company.vendorCredits) } : {}),
    },
    company,
  );
}

function createJournalEntry(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  if (!Array.isArray(input.Line) || input.Line.length === 0) return refused('2250');
  const lines = linesOf(company, input.Line, 'JournalEntryLineDetail');
  if (typeof lines === 'string') return refused(lines);
  let balance = 0;
  for (const [index, detail] of lines.details.entries()) {
    const sign =
      detail.PostingType === 'Debit' ? 1 : detail.PostingType === 'Credit' ? -1 : undefined;
    if (sign === undefined) return refused('2260');
    balance += sign * (lines.amounts[index] ?? 0);
  }
  if (balance !== 0) return refused('2300');
  return created(company.journalEntries, 'JournalEntry', input, { TotalAmt: 0 }, company);
}

/** QuickBooks' answer to a create the simulator knows; `undefined` for any other operation. */
export function answerCreate(
  company: SimulatedCompany,
  operation: string,
  input: JsonObject,
): ProviderAnswer | undefined {
  switch (operation) {
    case 'vendor.create':
      return createVendor(company, input);
    case 'bill.create':
      return createBill(company, input);
    case 'purchase.create':
      return createPurchase(company, input);
    case 'vendorCredit.create':
      return createVendorCredit(company, input);
    case 'journalEntry.create':
      return createJournalEntry(company, input);
    default:
      return undefined;
  }
}
