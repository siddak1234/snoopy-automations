import { answersOf, type Step } from '@autom8x/automation-sdk';

import { DECIDED, finalCodes } from '../decisions.js';
import { viewOf } from '../view.js';

/**
 * Codes saved: the final codes, ready to enter in your chart. Calls nothing that could be repeated;
 * applies the accepted changes only (`finalCodes`), from the review's answers on a continued run.
 */
export const save: Step = ({ request, state }) => {
  const view = viewOf(state);
  const answers = answersOf(request);
  const decisions = view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => ({ id: r.id, accepted: answers.get(r.id) === 'accepted' }));
  const codes = finalCodes(view.rows, answers);
  return Promise.resolve({
    outcome: 'ok',
    summary: 'Codes saved',
    state: { ...state, decisions, finalCodes: codes },
  });
};
