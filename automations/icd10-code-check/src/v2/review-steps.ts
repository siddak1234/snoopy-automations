import {
  answersOf,
  boundedBlocks,
  failed,
  held,
  settle,
  type DecisionAnswer,
  type InvokeRequest,
  type JsonObject,
  type Step,
} from '@autom8x/automation-sdk';

import type { Row } from '../checks.js';
import { DECIDED, finalCodes } from '../decisions.js';
import { readingOf, withoutPatient } from '../reading.js';
import { viewOf } from '../view.js';
import { WORDS } from '../words.js';
import {
  ACCEPTED_KEY,
  EXAMPLES_KEY,
  acceptedOf,
  deidentified,
  exampleOf,
  examplesOf,
  learn,
  learning,
  remember,
} from './memory.js';
import { rowAnswers, visitReview } from './review.js';
import { WORDS_V2 } from './words.js';

/**
 * A visit's run, the second half (the spec's v2 section, rows 6 to 8): the review, its changes
 * grouped under the visit's title, each with its why; then the save, which writes the codes the
 * clinic accepted and its de-identified examples to its memory, read by the next visit's ranking.
 */

/** The run's answers by its rows' own ids (decision ids `v1-…`). */
export const visitAnswers = (request: InvokeRequest): Map<string, DecisionAnswer> =>
  rowAnswers(answersOf(request));

/** Ready to save? Codes that match go through; each change waits for your review, grouped. */
export const reviewVisit: Step = ({ state }) => {
  const view = viewOf(state);
  const review = visitReview(view);
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
 * Codes saved: the final codes (v1's `finalCodes`, the accepted changes applied); each code
 * accepted written to the clinic's memory; and, while the clinic learns, each decision written as
 * a de-identified example (`exampleOf`, `learn`) — or, once "Learn from this clinic's reviews" is
 * off, the examples cleared. A memory that cannot be read or written is shown on the timeline, and
 * the codes stay saved. Two runs saving at once can lose one's write (README, the v2 changes'
 * row 3, a known limit).
 */
export const saveVisit: Step = async (context) => {
  const { request, state, platform } = context;
  const view = viewOf(state);
  const reading = readingOf(state.reading);
  const answers = visitAnswers(request);
  const decided = view.rows.filter((r) => DECIDED.has(r.verdict) && answers.has(r.id));
  const decisions = view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => ({ id: r.id, accepted: answers.get(r.id) === 'accepted' }));
  const accepted = acceptedCodes(view.rows, answers);
  const learns = learning(request.config);
  const examples = decided.flatMap((r) => {
    const said = r.from === undefined ? undefined : reading.diagnoses[r.from]?.statement;
    if (!learns || said === undefined) return [];
    const statement = deidentified(withoutPatient(said, reading));
    const verdict = answers.get(r.id) === 'accepted' ? 'accepted' : 'denied';
    return [exampleOf(statement, r.verdict === 'change' ? r.suggested! : r.code, verdict)];
  });
  const writes: [string, (before: unknown) => unknown][] = [];
  if (accepted.length > 0) {
    writes.push([ACCEPTED_KEY, (before) => remember(acceptedOf(before), accepted)]);
  }
  if (examples.length > 0)
    writes.push([EXAMPLES_KEY, (before) => learn(examplesOf(before), examples)]);
  else if (!learns) writes.push([EXAMPLES_KEY, () => null]);
  let wrote = true;
  let cleared = false;
  for (const [key, next] of writes) {
    const kept = await settle(context, () => platform.memory.get(key));
    if (!kept.ok) {
      wrote = false;
      continue;
    }
    const value = next(kept.value);
    if (value === null && kept.value === null) continue;
    const put = await settle(context, () => platform.memory.put(key, value));
    wrote &&= put.ok;
    cleared ||= put.ok && value === null;
  }
  const measures = {
    ...((state.measures ?? {}) as JsonObject),
    examplesSaved: wrote ? examples.length : 0,
    examplesCleared: cleared,
  };
  const next = { ...state, decisions, finalCodes: finalCodes(view.rows, answers), measures };
  if (!wrote) return { outcome: 'failed', summary: WORDS_V2.notRemembered, state: next };
  return { outcome: 'ok', summary: 'Codes saved', state: next };
};
