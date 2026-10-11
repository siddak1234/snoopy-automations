import assert from 'node:assert/strict';

import type { JsonObject } from '@autom8x/automation-sdk';

import { checkFirstRead, type CheckInput, type CheckOutcome } from '../src/checks/check.js';
import type { AccountRef, DocumentState, PayerState } from '../src/state.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * `check-document`'s decision as a pure function, for the suites that drive it with one answer at
 * a time: the run's date fixed, the company the simulator names, and the accounts and payers the
 * settings may give.
 */

/** The run's UTC date in these suites. */
export const TODAY = '2026-10-11';

export const VISA: AccountRef = {
  id: '41',
  fullyQualifiedName: 'Company Visa',
  accountType: 'Credit Card',
};
export const CHECKING: AccountRef = {
  id: '35',
  fullyQualifiedName: 'Checking',
  accountType: 'Bank',
};
export const TEAM_OWED: AccountRef = {
  id: '120',
  fullyQualifiedName: 'Owed to Team Members',
  accountType: 'Other Current Liability',
};
export const OWNER_EQUITY: AccountRef = {
  id: '125',
  fullyQualifiedName: 'Owner investments',
  accountType: 'Equity',
};

/** Who paid, as find-payer keeps each route. */
export const PAYERS: Readonly<Record<'owner' | 'employee' | 'not_employee', PayerState>> = {
  owner: { route: 'owner', name: 'Pat Owner', employeeId: null, account: OWNER_EQUITY },
  employee: { route: 'employee', name: 'Robin Example', employeeId: '55', account: TEAM_OWED },
  not_employee: { route: 'not_employee', name: 'Sam Lee', employeeId: null, account: null },
};

/** A made-up sample's expected answer, by its name. */
export function sampleAnswer(name: string, changes: JsonObject = {}): JsonObject {
  const sample = SAMPLES.find((each) => each.name === name);
  assert.ok(sample, name);
  return { ...structuredClone(sample.answer), ...changes };
}

/** A bill of $413.34 whose parts and lines add up (the typed sample). */
export const bill = (changes: JsonObject = {}) => sampleAnswer('typed-text-pdf', changes);
/** A receipt of $60.63 paid by card ending 4417, parts and lines adding up. */
export const receipt = (changes: JsonObject = {}) => sampleAnswer('receipt', changes);
/** A credit memo kept on account, its amounts printed with minus signs. */
export const creditNote = (changes: JsonObject = {}) => sampleAnswer('credit-memo', changes);
/** A supplier's statement of six rows that add up to its $686.54 balance. */
export const statement = (changes: JsonObject = {}) => sampleAnswer('supplier-statement', changes);

export function check(answer: unknown, options: Partial<CheckInput> = {}): CheckOutcome {
  return checkFirstRead({
    answer,
    switchOn: false,
    payer: null,
    paidFrom: VISA,
    companyName: 'Sample Bakery',
    legalName: 'Sample Bakery LLC',
    today: TODAY,
    ...options,
  });
}

/** With the switch on and `payer` as who paid. */
export function paidBy(payer: keyof typeof PAYERS, options: Partial<CheckInput> = {}) {
  return { switchOn: true, payer: PAYERS[payer], ...options };
}

/** The document an answer checks to; fails the test when a rule stopped it. */
export function documentOf(outcome: CheckOutcome): DocumentState {
  assert.equal(outcome.outcome, 'ok', outcome.outcome === 'failed' ? outcome.rule : '');
  return (outcome as Extract<CheckOutcome, { outcome: 'ok' }>).document;
}

/** The rule an answer fails, or 'ok'. */
export function ruleOf(outcome: CheckOutcome): string {
  return outcome.outcome === 'failed' ? outcome.rule : 'ok';
}
