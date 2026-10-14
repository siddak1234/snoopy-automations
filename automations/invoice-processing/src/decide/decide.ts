import type { JsonObject } from '@autom8x/automation-sdk';

import type { ExpenseSearch } from '../lookups/expense-search.js';
import type { NotRecordedReason } from '../quickbooks-path.js';
import { readDecideState } from './contract.js';
import { DECIDE_REASONS, failRuleOf } from './fails.js';
import { holdsOf, reasonLine, type Hold } from './holds.js';
import { matchesOf } from './matches.js';
import { recordPlan } from './plan.js';
import { recheckOf } from './recheck.js';
import { SAVED_MAXIMUM_BYTES, savedBytes, savedStateOf, type SavedState } from './saved.js';
import { statementLine, statementResult, type StatementResult } from './statement.js';

/**
 * decide: one result for the run — record, hold, compare, or not record — as a pure function of
 * the state the steps before it leave and the flow's settings (the plan's §2.6; v2's §2.5–§2.6).
 * Its order: the state complete, else the run fails ("Something went wrong"); the path's rules
 * (F1–F7), first match winning — not recorded; a statement compared and the run done, never held;
 * the accounts picked from the chart — none that could take it, not recorded; then every hold
 * reason, collected into ONE hold, or none — and the record planned once, with the re-check an
 * approval repeats, saved for after approval in the same shape either way, refused over 32 KiB.
 */

export interface DecideInput {
  /** The run state, as the runner hands it to the step. */
  readonly state: JsonObject;
  /** The flow's settings: the approval limit. */
  readonly config: JsonObject;
  /** How the lookups searched expenses (sandbox S4), which says which lookups had to run; D21's by default. */
  readonly expenseSearch?: ExpenseSearch;
}

export type Decision =
  | { readonly outcome: 'failed'; readonly failure: 'state_incomplete' | 'saved_too_large' }
  | { readonly outcome: 'not_recorded'; readonly reason: NotRecordedReason }
  | { readonly outcome: 'compared'; readonly summary: string; readonly result: StatementResult }
  | { readonly outcome: 'ok'; readonly saved: SavedState }
  | {
      readonly outcome: 'held';
      /** The approval's reason: every hold's phrase (§2.6). */
      readonly reason: string;
      readonly holds: readonly Hold[];
      readonly saved: SavedState;
    };

export function decideRun(input: DecideInput): Decision {
  const state = readDecideState(input.state, input.expenseSearch);
  if (!state) return { outcome: 'failed', failure: 'state_incomplete' };
  const rule = failRuleOf(state);
  if (rule !== undefined) return { outcome: 'not_recorded', reason: DECIDE_REASONS[rule] };
  if (state.document.route === 'statement') {
    const result = statementResult(state);
    return { outcome: 'compared', summary: statementLine(result), result };
  }
  const matches = matchesOf(state);
  const planned = recordPlan(state, matches);
  if (planned.kind === 'not_recordable') return { outcome: 'not_recorded', reason: planned.reason };
  const { plan } = planned;
  const holds = holdsOf({ state, config: input.config, matches });
  const saved = savedStateOf(
    state,
    plan,
    matches,
    holds.map((hold) => hold.code),
    recheckOf(state, plan, input.expenseSearch),
  );
  if (savedBytes(saved) > SAVED_MAXIMUM_BYTES)
    return { outcome: 'failed', failure: 'saved_too_large' };
  if (holds.length === 0) return { outcome: 'ok', saved };
  return { outcome: 'held', reason: reasonLine(holds), holds, saved };
}
