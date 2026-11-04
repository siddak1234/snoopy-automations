import { Buffer } from 'node:buffer';

import {
  RESULT_BODY_LIMIT_BYTES,
  answersOf,
  boundedBlocks,
  failed,
  held,
  othersOf,
  settle,
  type DecisionAnswer,
  type EmittedBlock,
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
import { otherCodesOf, rowAnswers, visitReview, type GroupedDecision } from './review.js';
import { WORDS_V2 } from './words.js';

/**
 * A visit's run, the second half (the spec's v2 section, rows 6 to 8): the review, its changes
 * grouped under the visit's title, each with its why; then the save, which writes the codes the
 * clinic accepted and its de-identified examples to its memory, read by the next visit's ranking.
 */

/** The run's answers by its rows' own ids (decision ids `v1-…`). */
export const visitAnswers = (request: InvokeRequest): Map<string, DecisionAnswer> =>
  rowAnswers(answersOf(request));

/** The other code a person picked in a change's place (v3), by its row's own id. */
export const visitOthers = (request: InvokeRequest): Map<string, string> =>
  rowAnswers(othersOf(request));

/**
 * Whether the held result, as the result callback sends it, stays within the platform's body
 * bound (`RESULT_BODY_LIMIT_BYTES`): v3's other codes counted, so they never cost the review its
 * blocks (the SDK's `boundedResult` would leave those out first).
 */
function heldFits(
  state: JsonObject,
  reason: string,
  decisions: readonly GroupedDecision[],
  blocks: readonly EmittedBlock[] | undefined,
): boolean {
  const body = {
    runId: '00000000-0000-4000-8000-000000000000',
    outcome: 'held',
    held: { stepId: 'review-visit', reason, state, decisions },
    ...(blocks === undefined ? {} : { blocks }),
  };
  return Buffer.byteLength(JSON.stringify(body), 'utf8') <= RESULT_BODY_LIMIT_BYTES;
}

/**
 * Ready to save? Codes that match go through; each change waits for your review, grouped. On a
 * v3 run each Change offers its other codes, while the held result with them fits the platform's
 * body bound (`heldFits`); past it, none is offered, the held state keeps none either, and each
 * change is accepted or denied, as on v2.
 */
export const reviewVisit: Step = ({ state }) => {
  const view = viewOf(state);
  const review = visitReview(view, otherCodesOf(state));
  if ('stop' in review) return Promise.resolve(failed(review.stop, 'too_many_changes'));
  if (review.decisions.length === 0) {
    return Promise.resolve({ outcome: 'ok', summary: 'Ready to save?' });
  }
  const blocks = boundedBlocks(review.blocks);
  const heldReason = WORDS.held(review.decisions.length);
  const fits = heldFits(state, heldReason, review.decisions, blocks);
  const { others: _others, ...lean } = state;
  const decisions = fits
    ? review.decisions
    : review.decisions.map(({ options: _options, ...decision }) => decision);
  return Promise.resolve(
    held({
      summary: WORDS.summaryHeld(view.rows.length, review.decisions.length),
      heldReason,
      state: fits ? state : lean,
      decisions,
      ...(blocks === undefined ? {} : { blocks }),
    }),
  );
};

/**
 * The codes a person accepted: a Change's suggestion, an Add's code, and (v3) the other code
 * picked in a Change's place.
 */
export const acceptedCodes = (
  rows: readonly Row[],
  answers: ReadonlyMap<string, string>,
  others: ReadonlyMap<string, string> = new Map(),
) =>
  rows
    .filter((r) => DECIDED.has(r.verdict))
    .flatMap((r) =>
      answers.get(r.id) === 'other' && others.has(r.id)
        ? [others.get(r.id)!]
        : answers.get(r.id) !== 'accepted'
          ? []
          : r.verdict === 'change'
            ? [r.suggested!]
            : r.verdict === 'add'
              ? [r.code]
              : [],
    );

/**
 * Codes saved: the final codes (v1's `finalCodes`, the accepted changes applied, and on v3 each
 * other code picked in its change's place); each code accepted written to the clinic's memory;
 * and, while the clinic learns, each decision written as a de-identified example (`exampleOf`,
 * `learn`) — an other code picked as an accepted example and the suggestion it replaced as a denied
 * one — or, once "Learn from this clinic's reviews" is off, the examples cleared. A memory that
 * cannot be read or written is shown on the timeline, and the codes stay saved. Two runs saving at
 * once can lose one's write (README, the v2 changes' row 3, a known limit).
 */
export const saveVisit: Step = async (context) => {
  const { request, state, platform } = context;
  const view = viewOf(state);
  const reading = readingOf(state.reading);
  const answers = visitAnswers(request);
  const others = visitOthers(request);
  const decided = view.rows.filter((r) => DECIDED.has(r.verdict) && answers.has(r.id));
  const decisions = view.rows
    .filter((r) => DECIDED.has(r.verdict))
    .map((r) => ({
      id: r.id,
      accepted: answers.get(r.id) === 'accepted',
      ...(others.has(r.id) ? { other: others.get(r.id)! } : {}),
    }));
  const accepted = acceptedCodes(view.rows, answers, others);
  const learns = learning(request.config);
  const examples = decided.flatMap((r) => {
    const said = r.from === undefined ? undefined : reading.diagnoses[r.from]?.statement;
    if (!learns || said === undefined) return [];
    const statement = deidentified(withoutPatient(said, reading));
    const suggested = r.verdict === 'change' ? r.suggested! : r.code;
    const other = others.get(r.id);
    if (other !== undefined) {
      return [exampleOf(statement, other, 'accepted'), exampleOf(statement, suggested, 'denied')];
    }
    const verdict = answers.get(r.id) === 'accepted' ? 'accepted' : 'denied';
    return [exampleOf(statement, suggested, verdict)];
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
  const next = {
    ...state,
    decisions,
    finalCodes: finalCodes(view.rows, answers, others),
    measures,
  };
  if (!wrote) return { outcome: 'failed', summary: WORDS_V2.notRemembered, state: next };
  return { outcome: 'ok', summary: 'Codes saved', state: next };
};
