import { held, type JsonObject, type Step } from '@autom8x/automation-sdk';

import { failedWith } from '../outcome.js';
import { decideRun } from './decide.js';
import { DECIDE_REASONS } from './fails.js';

/**
 * decide as a step. Built and tested now, and NOT in the pipeline yet: it reads the lookups'
 * records (the plan's Group 4, steps 9–17), which are not built — a step the manifest declares
 * must have code, and code the manifest does not declare must not run (test/conformance.test.ts).
 * Group 4 adds it to `define`'s steps and to the manifest, after its lookups.
 *
 * - failed: the fixed sentence, nothing created;
 * - a statement compared: ok, the run's state replaced by the comparison, which the run's output
 *   carries — nothing is written and nothing waits for approval;
 * - straight through: ok, the state replaced by the saved plan;
 * - held: one approval, with the saved plan as the state the platform keeps and hands back.
 */
export function decide(): Step {
  return ({ request, state }) => {
    const decision = decideRun({
      state,
      config: request.config,
      switchOn: request.input.paidPersonally === true,
      runId: request.runId,
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
