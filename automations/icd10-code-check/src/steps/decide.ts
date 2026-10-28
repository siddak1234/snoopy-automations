import { boundedBlocks, held, type Step } from '@autom8x/automation-sdk';

import { heldBlocks } from '../blocks.js';
import { decisionsOf } from '../decisions.js';
import { viewOf } from '../view.js';
import { WORDS } from '../words.js';

/**
 * Ready to save? Codes that match go through; each change waits for your review: the run is held
 * when any verdict is Change, Add, Remove or Move up, with one decision per change, and the held
 * run shows blocks (1) to (7) (the spec's section 7).
 */
export const decide: Step = ({ state }) => {
  const view = viewOf(state);
  const decisions = decisionsOf(view.rows);
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
