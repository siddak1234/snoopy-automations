import assert from 'node:assert/strict';

import {
  QuickBooksSimulator,
  sampleBill,
  sampleCustomer,
  sampleJournalEntry,
  samplePurchase,
  sampleVendor,
} from '@autom8x/automation-kit/testing';
import type { JsonObject, RunResult } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import type { ExpenseSearch } from '../src/lookups/expense-search.js';
import { FILE_ID, callsOf, lines, reads, setUp } from './fixtures.js';

/**
 * Group 4's world: a whole run of v1 — steps 1–18 — on the kit's simulator, holding the made-up
 * company's vendors, customers and records the samples name, with the run's settings and inputs for
 * each route; and readers for what each lookup step sent and wrote.
 */

/** The lookup steps, in the pipeline's order. */
export const LOOKUP_STEPS = [
  'find-vendor',
  'find-vendor-company',
  'find-similar-vendors',
  'find-customer-name',
  'find-employee-name',
  'find-duplicate-number',
  'find-duplicate-amount',
  'find-related',
  'find-other-record',
] as const;

/** References to the made-up company's vendors and accounts, as QuickBooks writes them. */
export const REF = {
  harrowgate: { value: '7', name: 'Harrowgate Office Supply' },
  tidewell: { value: '9', name: 'Tidewell Hardware' },
  wrenfield: { value: '12', name: 'Wrenfield & Pike Bookkeeping' },
  samLee: { value: '31', name: 'Sam Lee' },
  other: { value: '88', name: 'Pacific Gas' },
  visa: { value: '41', name: 'Company Visa' },
  checking: { value: '35', name: 'Checking' },
  electric: { value: '57', name: 'Utilities:Electric' },
  teamOwed: { value: '120', name: 'Owed to Team Members' },
  meals: { value: '66', name: 'Meals' },
} as const;

/** The vendors the samples' sellers are, a contractor marked 1099, and another vendor. */
export function seededCompany(simulator: QuickBooksSimulator): QuickBooksSimulator {
  simulator.company.vendors.push(
    sampleVendor('7', 'Harrowgate Office Supply', { Balance: 980 }),
    sampleVendor('9', 'Tidewell Hardware'),
    sampleVendor('12', 'Wrenfield & Pike Bookkeeping'),
    sampleVendor('31', 'Sam Lee', { CompanyName: 'Lee Fixtures', Vendor1099: true }),
    sampleVendor('88', 'Pacific Gas'),
  );
  return simulator;
}

export interface RouteRun {
  /** Read 1's answer; read 2 agrees. */
  readonly answer: JsonObject;
  readonly config?: JsonObject;
  readonly input?: JsonObject;
  /** Changes to the made-up company before the run. */
  readonly company?: (simulator: QuickBooksSimulator) => void;
  readonly expenseSearch?: ExpenseSearch;
  /** The last step run; the whole of v1 by default. */
  readonly through?: string;
  /** No vendor in the company: every seller is new. */
  readonly bare?: boolean;
}

/** Settings and inputs per way of paying. */
export const PAID = {
  /** The company, from its card. */
  company: { config: { expenseAccount: 'Utilities:Electric', paidFromAccount: 'Company Visa' } },
  /** The company, from its bank account. */
  bank: { config: { expenseAccount: 'Utilities:Electric', paidFromAccount: 'Checking' } },
  employee: {
    config: { expenseAccount: 'Utilities:Electric', teamOwedAccount: 'Owed to Team Members' },
    input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Robin Example' },
  },
  owner: {
    config: {
      expenseAccount: 'Utilities:Electric',
      ownerNames: 'Pat Owner',
      ownerInvestmentAccount: 'Owner investments',
    },
    input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Pat Owner' },
  },
  contractor: {
    config: { expenseAccount: 'Utilities:Electric' },
    input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Sam Lee' },
  },
} as const;

/** A whole run of one document, on the seeded company. */
export async function routeRun(run: RouteRun) {
  const how = run.expenseSearch ?? 'amount';
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.expenseAmountSearchable = how === 'amount';
  if (!run.bare) seededCompany(simulator);
  run.company?.(simulator);
  const world = setUp({
    simulator,
    through: run.through ?? 'decide',
    expenseSearch: how,
    config: run.config ?? PAID.company.config,
    ...(run.input ? { input: run.input } : {}),
  });
  world.platform.model = reads(run.answer);
  const result = await world.run();
  return { ...world, result };
}

type World = Awaited<ReturnType<typeof routeRun>>;

/** The query text each lookup step sent, by step; a step that sent none is absent. */
export function queriesOf(world: World): Record<string, string> {
  const sent: Record<string, string> = {};
  for (const stepId of LOOKUP_STEPS) {
    const calls = callsOf(world.platform, world.request, stepId);
    if (calls.length === 0) continue;
    // One distinct request a step, every attempt the same bytes.
    assert.equal(new Set(calls.map((call) => JSON.stringify(call))).size, 1, stepId);
    assert.equal(calls[0]?.operation, 'query.run', stepId);
    sent[stepId] = String(calls[0]?.input.query);
  }
  return sent;
}

/** The step's timeline line, or undefined when it reported none (skipped). */
export function lineOf(world: World, stepId: string): string | undefined {
  return lines(world.platform).find(([id]) => id === stepId)?.[2];
}

/** The steps that reported, in order. */
export const reported = (world: World) => lines(world.platform).map(([stepId]) => stepId);

/** The run's whole state, for a run cut short with `through`. */
export function stateOf(result: RunResult): JsonObject {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  return (result as Extract<RunResult, { outcome: 'success' }>).output ?? {};
}

export { sampleBill, sampleCustomer, sampleJournalEntry, samplePurchase, sampleVendor };
