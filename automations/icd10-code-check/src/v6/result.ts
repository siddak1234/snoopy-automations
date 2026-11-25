import {
  boundedBlocks,
  isObject,
  type EmittedBlock,
  type JsonObject,
} from '@autom8x/automation-sdk';

import { keptBlocks } from '../blocks.js';
import { viewOf } from '../view.js';
import { everyChange, visitCodes } from './codes.js';
import { notesOf } from './paths.js';
import { WORDS_V6 } from './words.js';

/**
 * What a v6 visit run gives beyond v5's result (README, "v6", rows 3 to 5): a hook run's
 * `diagnosisCodes`, the card's one input — an empty list when no note was read or no code found
 * (the card's `no_codes`, the session's choice over leaving it out, which reads as
 * `codes_invalid`) — with the notes it read counted; an upload's visit its chart note's outcome,
 * in its output and as a last line, only once the step ran (the EHR picked).
 */

interface Done {
  title: string;
  summary: string;
  blocks?: readonly EmittedBlock[];
  output: JsonObject;
}

/**
 * A hook run: v5's visit result, its summary the codes suggested, its output with them, and its
 * blocks v5's with nothing to decide — the patient, the codes table and the asks — without the
 * "All codes supported" badge, which a code to add would belie; no review was asked here.
 */
export function hookResult(done: Done, state: JsonObject): Done {
  const view = viewOf(state);
  const read = notesOf(state).length > 0;
  const codes = read
    ? visitCodes(view.rows, everyChange(view.rows), view.titles, view.tableName)
    : [];
  const measures = isObject(done.output.measures) ? done.output.measures : {};
  const output = {
    ...done.output,
    diagnosisCodes: codes.map((one) => ({ ...one })),
    measures: { ...measures, notes: isObject(state.notesRead) ? { ...state.notesRead } : null },
  };
  const blocks = boundedBlocks(
    read
      ? keptBlocks(view).filter((block) => block.type !== 'badge')
      : [{ type: 'text', text: WORDS_V6.noNotes }],
  );
  return {
    title: done.title,
    summary: read ? WORDS_V6.hookSummary(codes.length) : WORDS_V6.noNoteSummary,
    ...(blocks === undefined ? {} : { blocks }),
    output,
  };
}

/** An upload's visit: its chart note's outcome in its output and its last block, when written of. */
export function withChartNote<R extends Done>(done: R, state: JsonObject): R {
  const chart = state.chartNote;
  if (!isObject(chart)) return done;
  const line =
    chart.outcome === 'written'
      ? WORDS_V6.written
      : WORDS_V6.notWritten(typeof chart.reason === 'string' ? chart.reason : '');
  const blocks = boundedBlocks([...(done.blocks ?? []), { type: 'text', text: line }]);
  return {
    ...done,
    ...(blocks === undefined ? {} : { blocks }),
    output: { ...done.output, chartNote: { ...chart } },
  };
}
