import { DECISION_LIMITS, boundedBlocks, failed, held, type Step } from '@autom8x/automation-sdk';

import { heldBlocks } from '../blocks.js';
import { decisionsOf } from '../decisions.js';
import { viewOf } from '../view.js';
import { FAILURES, WORDS } from '../words.js';

/**
 * Ready to save? Codes that match go through; each change waits for your review: the run is held
 * when any verdict is Change, Add, Remove or Move up, with one decision per change, and the held
 * run shows blocks (1) to (7) (the spec's section 7). More than 40 changes stop in section 8's
 * words (the owner, 2026-10-28 ~23:17Z, "Stop past 40 changes"): the platform takes at most 40.
 */
export const decide: Step = ({ state }) => {
  const view = viewOf(state);
  const decisions = decisionsOf(view.rows, view.titles);
  if (decisions.length > DECISION_LIMITS.decisions)
    return Promise.resolve(failed(FAILURES.tooManyChanges, 'too_many_changes'));
  if (decisions.length === 0) return Promise.resolve({ outcome: 'ok', summary: 'Ready to save?' });
  const reason = WORDS.held(decisions.length);
  const blocks = boundedBlocks(heldBlocks(view));
  return Promise.resolve(
    held({
      summary: WORDS.summaryHeld(view.rows.length, decisions.length),
      heldReason: reason,
      state,
      decisions,
      ...(blocks === undefined ? {} : { blocks }),
    }),
  );
};
