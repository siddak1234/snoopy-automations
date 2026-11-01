import {
  answersOf,
  boundedBlocks,
  failed,
  held,
  settle,
  type DecisionAnswer,
  type InvokeRequest,
  type Step,
} from '@autom8x/automation-sdk';

import type { Row } from '../checks.js';
import { DECIDED, finalCodes } from '../decisions.js';
import { viewOf } from '../view.js';
import { WORDS } from '../words.js';
import { ACCEPTED_KEY, acceptedOf, remember } from './memory.js';
import { answersOfVisit, fileReview } from './review.js';
import { WORDS_V2 } from './words.js';

/**
 * A visit's run, the second half (the spec's v2 section, rows 6 to 8): the review, its changes
 * grouped under the visit's title, each with its why; then the save, which writes the codes the
 * clinic accepted to its memory, read by the next visit's ranking.
 */

/** The run's answers by its rows' own ids: a child run reviews one visit, decision ids `v1-…`. */
export const visitAnswers = (request: InvokeRequest): Map<string, DecisionAnswer> =>
  answersOfVisit(answersOf(request), 0);

/** Ready to save? Codes that match go through; each change waits for your review, grouped. */
export const reviewVisit: Step = ({ state }) => {
  const view = viewOf(state);
  const review = fileReview([view], view.directions, [view.tableName]);
  if ('stop' in review) return Promise.resolve(failed(review.stop, 'too_many_changes'));
  if (review.decisions.length === 0) {
    return Promise.resolve({ outcome: 'ok', summary: 'Ready to save?' });
  }
  const blocks = boundedBlocks(review.blocks);
  return Promise.resolve(
    held({
      summary: WORDS.summaryHeld(view.rows.length, review.decisions.length),
      heldReason: WORDS.held(review.decisions.length),
      state,
      decisions: review.decisions,
      ...(blocks === undefined ? {} : { blocks }),
    }),
  );
};

/** The codes a person accepted: a Change's suggestion, an Add's code. */
export const acceptedCodes = (rows: readonly Row[], answers: ReadonlyMap<string, string>) =>
  rows
    .filter((r) => DECIDED.has(r.verdict) && answers.get(r.id) === 'accepted')
    .flatMap((r) =>
      r.verdict === 'change' ? [r.suggested!] : r.verdict === 'add' ? [r.code] : [],
    );

/**
 * Codes saved: the final codes (v1's `finalCodes`, the accepted changes applied), and each code
 * accepted written to the clinic's memory. A memory that cannot be written is shown on the
 * timeline, and the codes stay saved.
 */
export const saveVisit: Step = async (context) => {
  const { request, state, platform } = context;
  const view = viewOf(state);
  const answers = visitAnswers(request);
  const decisions = view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => ({ id: r.id, accepted: answers.get(r.id) === 'accepted' }));
  const next = { ...state, decisions, finalCodes: finalCodes(view.rows, answers) };
  const accepted = acceptedCodes(view.rows, answers);
  if (accepted.length === 0) return { outcome: 'ok', summary: 'Codes saved', state: next };
  const kept = await settle(context, () => platform.memory.get(ACCEPTED_KEY));
  const wrote = kept.ok
    ? await settle(context, () =>
        platform.memory.put(ACCEPTED_KEY, remember(acceptedOf(kept.value), accepted)),
      )
    : kept;
  if (!wrote.ok) return { outcome: 'failed', summary: WORDS_V2.notRemembered, state: next };
  return { outcome: 'ok', summary: 'Codes saved', state: next };
};
