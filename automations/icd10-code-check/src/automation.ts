import {
  answersOf,
  boundedBlocks,
  defineFlow,
  type Automation,
  type JsonObject,
  type InvokeRequest,
  type Manifest,
} from '@autom8x/automation-sdk';

import { doneBlocks, keptBlocks, titleOf } from './blocks.js';
import { DECIDED } from './decisions.js';
import { prompts } from './prompts.js';
import { readingOf } from './reading.js';
import { checkCodes } from './steps/check-codes.js';
import { checkNote, type CheckNoteOptions } from './steps/check-note.js';
import { decide } from './steps/decide.js';
import { findCodes } from './steps/find-codes.js';
import { matchCodes } from './steps/match-codes.js';
import { readNote } from './steps/read-note.js';
import { receive } from './steps/receive.js';
import { save } from './steps/save.js';
import { TABLES } from './tables.js';
import { viewOf } from './view.js';
import { WORDS } from './words.js';

/** ICD-10 Code Check, on `defineFlow`: its spec is README.md beside src/. */
export const TEMPLATE_ID = 'icd10-code-check';

export { prompts };

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The flow. `options` are for its suite: the day a run starts and the tables the build holds
 * (`check-note`). Each AI step is run once more on a failure that decided nothing (README,
 * "Retrying a step"): `settle` rethrows while a repeat is left, and never once a model answered.
 */
export function define(
  manifests: readonly Manifest[],
  options: Partial<CheckNoteOptions> = {},
): Automation {
  return defineFlow({
    templateId: TEMPLATE_ID,
    manifests,
    prompts,
    steps: {
      receive,
      'read-note': readNote,
      'check-note': checkNote({ today: options.today ?? today, tables: options.tables ?? TABLES }),
      'find-codes': findCodes,
      'match-codes': matchCodes,
      'check-codes': checkCodes,
      decide,
      save,
    },
    retry: {
      'read-note': { attempts: 2, backoffMs: 10_000 },
      'match-codes': { attempts: 2, backoffMs: 10_000 },
    },
    result,
  });
}

/** What a run gives (the spec, section 7): its title, summary, blocks and output; never `documents`. */
function result(state: JsonObject, request: InvokeRequest) {
  const view = viewOf(state);
  const reading = readingOf(state.reading);
  const answers = answersOf(request);
  const reviewed = view.rows.some((r) => DECIDED.has(r.verdict));
  const codes = Array.isArray(state.finalCodes) ? (state.finalCodes as string[]) : [];
  const accepted = [...answers.values()].filter((answer) => answer === 'accepted').length;
  const n = view.rows.length;
  const summary = reviewed
    ? WORDS.summaryDone(n, accepted, answers.size - accepted)
    : view.asks.length === 0
      ? WORDS.summaryKept(n)
      : WORDS.summaryHeld(n, view.asks.length);
  const blocks = boundedBlocks(reviewed ? doneBlocks(view, answers, codes) : keptBlocks(view));
  return {
    title: titleOf(view),
    summary,
    ...(blocks === undefined ? {} : { blocks }),
    output: {
      patient: { ...reading.patient },
      visitDate: view.visitDate,
      codeTable: view.tableName,
      specialties: Array.isArray(state.specialties) ? state.specialties : [],
      codesOnNote: reading.codesOnNote,
      verdicts: view.rows.map((r) => ({
        id: r.id,
        code: r.code,
        verdict: r.verdict,
        suggested: r.suggested,
        check: r.check,
        quote: r.quote,
      })),
      decisions: Array.isArray(state.decisions) ? state.decisions : [],
      finalCodes: codes,
    },
  };
}
