import { held, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { EXPENSE_SEARCH, type ExpenseSearch } from '../lookups/expense-search.js';
import { failedWith } from '../outcome.js';
import { decideRun } from './decide.js';
import { DECIDE_REASONS } from './fails.js';

/**
 * decide as a step — step 18, after the lookups (steps 9–17) whose records it reads; no QuickBooks
 * or model call, so nothing to repeat. `expenseSearch` is how those lookups searched expenses
 * (sandbox S4), which says which of them had to run.
 *
 * - failed: the fixed sentence, nothing created;
 * - a statement compared: ok, the run's state replaced by the comparison, which the run's output
 *   carries — nothing is written and nothing waits for approval;
 * - straight through: ok, the state replaced by the saved plan;
 * - held: the SDK's held outcome — the run ends with one approval, the saved plan the state the
 *   platform keeps and hands back, and an approval resumes after decide.
 */
export function decide(expenseSearch: ExpenseSearch = EXPENSE_SEARCH): Step {
  return ({ request, state }) => {
    const decision = decideRun({
      state,
      config: request.config,
      switchOn: request.input.paidPersonally === true,
      runId: request.runId,
      expenseSearch,
    });
    switch (decision.outcome) {
      case 'failed':
        return Promise.resolve(
          failedWith('Not recorded', DECIDE_REASONS[decision.failure], decision.sentence),
        );
      case 'compared':
        return Promise.resolve({
          outcome: 'ok' as const,
          summary: decision.summary,
          state: decision.result as unknown as JsonObject,
        });
      case 'ok':
        return Promise.resolve({
          outcome: 'ok' as const,
          summary: decision.summary,
          state: decision.saved as unknown as JsonObject,
        });
      case 'held':
        return Promise.resolve(
          held({
            summary: decision.summary,
            heldReason: decision.heldReason,
            reason: decision.reason,
            state: decision.saved as unknown as JsonObject,
          }),
        );
    }
  };
}
