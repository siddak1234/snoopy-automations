import { held, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import { runFails } from '../outcome.js';
import { notRecorded } from '../quickbooks-path.js';
import { decideRun } from './decide.js';

/**
 * decide as a step — after the lookups whose records it reads, on the QuickBooks path only; no
 * QuickBooks or model call, so nothing to repeat. `expenseSearch` is how those lookups searched
 * expenses (sandbox S4), which says which of them had to run. Its title is the approval's headline,
 * "Record in QuickBooks?" (§3.F). Lines (§3.E): `Ready to record` or `Waiting for approval`.
 *
 * - not recorded: the run goes on, the details are saved (S2), the chart left behind;
 * - a statement compared: ok, the run's state replaced by the comparison, which the run's output
 *   carries — nothing is written and nothing waits for approval;
 * - straight through: ok, the state replaced by the saved plan;
 * - held: the SDK's held outcome — the run ends with one approval, the saved plan the state the
 *   platform keeps and hands back, and an approval resumes after decide.
 */
export function decide(expenseSearch: ExpenseSearch = EXPENSE_SEARCH): Step {
  return ({ request, state }) => {
    const decision = decideRun({ state, config: request.config, expenseSearch });
    switch (decision.outcome) {
      case 'failed':
        return Promise.resolve(runFails('other', decision.failure));
      case 'not_recorded': {
        // The plan is not made: the chart has done its work, and leaves the state.
        const { chart: _chart, ...rest } = state;
        return Promise.resolve(notRecorded(rest, decision.reason, 'ok'));
      }
      case 'compared':
        return Promise.resolve({
          outcome: 'ok' as const,
          summary: decision.summary,
          state: decision.result as unknown as JsonObject,
        });
      case 'ok':
        return Promise.resolve({
          outcome: 'ok' as const,
          summary: 'Ready to record',
          state: decision.saved as unknown as JsonObject,
        });
      case 'held':
        return Promise.resolve(
          held({
            summary: 'Waiting for approval',
            heldReason: decision.reason,
            reason: decision.reason,
            state: decision.saved as unknown as JsonObject,
          }),
        );
    }
  };
}
