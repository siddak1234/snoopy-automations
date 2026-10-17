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
import { runStateOf, SHARED_KEYS } from '../src/run/state.js';
import { QUICKBOOKS, callsOf, lines, reads, setUp } from './fixtures.js';

/**
 * The lookups' world: a whole run of one document on the kit's simulator, holding the made-up
 * company's vendors, customers and records the samples name, with QuickBooks chosen; and readers
 * for what each of v2's lookups sent and wrote — in v3 each runs inside one of four steps, under
 * the document's part of its key (`src/run/lookups.ts`).
 */

/** v2's lookups, in the pipeline's order: each the v3 step it runs in, and its part for document 1. */
export const LOOKUPS = {
  'find-vendor': ['find-vendors', 'd1'],
  'find-vendor-company': ['find-vendors', 'd1-a'],
  'find-similar-vendors': ['find-vendors', 'd1-b'],
  'find-customer-name': ['find-names', 'd1'],
  'find-employee-name': ['find-names', 'd1-a'],
  'find-duplicate-number': ['find-duplicates', 'd1'],
  'find-duplicate-amount': ['find-duplicates', 'd1-a'],
  'find-related': ['find-related', 'd1'],
  'find-other-record': ['find-related', 'd1-a'],
} as const;

export const LOOKUP_STEPS = Object.keys(LOOKUPS) as (keyof typeof LOOKUPS)[];

/** The v3 step one of v2's lookups runs in. */
export const stepOf = (lookup: string): string =>
  LOOKUPS[lookup as keyof typeof LOOKUPS]?.[0] ?? lookup;

/** The provider calls one of v2's lookups made for document 1, under its part of its v3 step's key. */
export function lookupCalls(world: Pick<World, 'platform' | 'request'>, lookup: string) {
  const [step, part] = LOOKUPS[lookup as keyof typeof LOOKUPS];
  return callsOf(world.platform, world.request, step, part);
}

/** v3's four lookup steps. */
export const V3_LOOKUP_STEPS = ['find-vendors', 'find-names', 'find-duplicates', 'find-related'];

/** References to the made-up company's vendors and accounts, as QuickBooks writes them. */
export const REF = {
  harrowgate: { value: '7', name: 'Harrowgate Office Supply' },
  tidewell: { value: '9', name: 'Tidewell Hardware' },
  wrenfield: { value: '12', name: 'Wrenfield & Pike Bookkeeping' },
  samLee: { value: '31', name: 'Sam Lee' },
  other: { value: '88', name: 'Pacific Gas' },
  visa: { value: '41', name: 'Company Visa' },
  visa4417: { value: '42', name: 'Visa 4417' },
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
  /** The last step run; the whole of v3 by default. */
  readonly through?: string;
  /** No vendor in the company: every seller is new. */
  readonly bare?: boolean;
}

/**
 * The flow's settings, and the made-up company's accounts, per way of paying: no setting names an
 * account in v2 — what a receipt was paid from is picked from the company's chart (decision 1).
 */
export const PAID = {
  /** QuickBooks chosen; the chart as the simulator holds it — a card named "Visa 4417". */
  company: { config: QUICKBOOKS },
  /** A company with one bank account and no card: a receipt is paid from Checking. */
  bank: { config: QUICKBOOKS, company: onlyChecking },
} as const;

/** The made-up company with Checking alone to pay from. */
export function onlyChecking(simulator: QuickBooksSimulator): void {
  simulator.company.accounts = simulator.company.accounts.filter(
    (account) => !['36', '41', '42'].includes(String(account.Id)),
  );
}

/** A whole run of one document, on the seeded company. */
export async function routeRun(run: RouteRun) {
  const how = run.expenseSearch ?? 'amount';
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  simulator.expenseAmountSearchable = how === 'amount';
  if (!run.bare) seededCompany(simulator);
  run.company?.(simulator);
  const world = setUp({
    simulator,
    through: run.through ?? 'all',
    expenseSearch: how,
    config: run.config ?? PAID.company.config,
    ...(run.input ? { input: run.input } : {}),
  });
  world.platform.model = reads(run.answer);
  const result = await world.run();
  return { ...world, result };
}

type World = Awaited<ReturnType<typeof routeRun>>;

/** The query text each of v2's lookups sent for document 1, by its v2 name; one that sent none is absent. */
export function queriesOf(world: World): Record<string, string> {
  const sent: Record<string, string> = {};
  for (const stepId of LOOKUP_STEPS) {
    const [step, part] = LOOKUPS[stepId];
    const calls = callsOf(world.platform, world.request, step, part);
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

/**
 * The run's state for its one document, for a run cut short with `through`: what the run shares
 * and the document's own keys, as v2 kept one document's state.
 */
export function stateOf(result: RunResult): JsonObject {
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  const state = (result as Extract<RunResult, { outcome: 'success' }>).output ?? {};
  const run = runStateOf(state);
  assert.ok(run, 'the state holds its documents');
  const shared = Object.fromEntries(
    [...SHARED_KEYS, 'quickBooks']
      .filter((key) => state[key] !== undefined)
      .map((key) => [key, state[key]]),
  );
  return { ...shared, ...run.documents[0]!.engine };
}

export { sampleBill, sampleCustomer, sampleJournalEntry, samplePurchase, sampleVendor };
