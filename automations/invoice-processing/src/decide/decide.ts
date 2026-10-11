import type { JsonObject } from '@autom8x/automation-sdk';

import { readDecideState } from './contract.js';
import { DECIDE_SENTENCES, failRuleOf, type DecideFailure } from './fails.js';
import { holdsOf, type Hold } from './holds.js';
import { matchesOf } from './matches.js';
import { recordPlan } from './plan.js';
import { SAVED_MAXIMUM_BYTES, savedBytes, savedStateOf, type SavedState } from './saved.js';
import { statementLine, statementResult, type StatementResult } from './statement.js';
import { approvalWording, heldSummary, notesOf, reasonLine, straightSummary } from './wording.js';

/**
 * decide (step 18): one result for the run — continue, hold or fail (the plan's §2.6) — as a pure
 * function of the state the steps before it leave, the flow's settings and the run's id. Its
 * order: the state complete, else "could not finish its checks"; the path's fail rules (F1–F7),
 * first match winning; a statement compared and the run done, never held; then every hold reason,
 * collected into ONE hold, or none — and the record planned once, saved for after approval in
 * the same shape either way, refused over 32 KiB.
 */

export interface DecideInput {
  /** The run state, as the runner hands it to the step. */
  readonly state: JsonObject;
  /** The flow's settings: the approval limit and the company card's digits. */
  readonly config: JsonObject;
  /** "I paid for this with my own money". */
  readonly switchOn: boolean;
  readonly runId: string;
}

export type Decision =
  | { readonly outcome: 'failed'; readonly failure: DecideFailure; readonly sentence: string }
  | { readonly outcome: 'compared'; readonly summary: string; readonly result: StatementResult }
  | { readonly outcome: 'ok'; readonly summary: string; readonly saved: SavedState }
  | {
      readonly outcome: 'held';
      /** decide's timeline line: what the reason line gave up first, the details that fit, the category. */
      readonly summary: string;
      /** The wording under decide's line: what approving creates (§2.7). */
      readonly heldReason: string;
      /** The approval's reason line. */
      readonly reason: string;
      readonly holds: readonly Hold[];
      readonly saved: SavedState;
    };

function failed(failure: DecideFailure): Decision {
  return { outcome: 'failed', failure, sentence: DECIDE_SENTENCES[failure] };
}

export function decideRun(input: DecideInput): Decision {
  const state = readDecideState(input.state);
  if (!state) return failed('state_incomplete');
  const rule = failRuleOf(state);
  if (rule !== undefined) return failed(rule);
  if (state.document.route === 'statement') {
    const result = statementResult(state, input.switchOn);
    return { outcome: 'compared', summary: statementLine(result), result };
  }
  const matches = matchesOf(state);
  const holds = holdsOf({ state, config: input.config, matches });
  const plan = recordPlan(state, input.runId, matches);
  const saved = savedStateOf(
    state,
    plan,
    matches,
    holds.map((hold) => hold.code),
  );
  if (savedBytes(saved) > SAVED_MAXIMUM_BYTES) return failed('saved_too_large');
  const notes = notesOf(state, plan);
  if (holds.length === 0) {
    return { outcome: 'ok', summary: straightSummary(state, plan, input.config, notes), saved };
  }
  return {
    outcome: 'held',
    summary: heldSummary(state, plan, holds, notes),
    heldReason: approvalWording(state, plan, matches),
    reason: reasonLine(state, plan, holds),
    holds,
    saved,
  };
}
