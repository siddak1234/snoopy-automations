import type { JsonObject, ProviderAnswer } from '@autom8x/automation-sdk';

import {
  TIME,
  TODAY,
  faultAnswer,
  readAnswer,
  type SimulatedCompany,
} from './quickbooks-company.js';

/**
 * QuickBooks creating an expense (`purchase.create`), a vendor credit (`vendorCredit.create`)
 * or a journal entry (`journalEntry.create`) in the made-up company — the operations the
 * platform's next pull request declares (the plan's P1–P3). Only what Intuit documents:
 * the required fields (Fault 2020), a reference to an account the company does not hold
 * (2500), a negative line (2290), a journal entry with no lines (2250), a line with no
 * posting type (2260) or debits unequal to credits (2300); the record answered as
 * `{ <Entity>: {…}, time }`, its Id assigned, its `TotalAmt` the sum of its lines — a
 * journal entry's always 0, as Intuit's model says — and kept, so a later query finds it.
 *
 * What only the sandbox can settle is not imitated: whether a payment type must match
 * its account's type, whether multicurrency makes `CurrencyRef` required (S13), whether a
 * journal entry's line may name an employee (S5), or how a closed period refuses a record.
 */

type Fault = '2020' | '2250' | '2260' | '2290' | '2300' | '2500';

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
  return created(company.purchases, 'Purchase', input, { TotalAmt: total }, company);
}

function createVendorCredit(company: SimulatedCompany, input: JsonObject): ProviderAnswer {
  // The simulator holds no vendors yet: a VendorRef is required, not looked up.
  if (refValue(input.VendorRef) === undefined) return refused('2020');
  const lines = linesOf(company, input.Line, 'AccountBasedExpenseLineDetail');
  if (typeof lines === 'string') return refused(lines);
  const total = lines.amounts.reduce((sum, each) => sum + each, 0) / 100;
  return created(
    company.vendorCredits,
    'VendorCredit',
    input,
    { TotalAmt: total, Balance: total },
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
