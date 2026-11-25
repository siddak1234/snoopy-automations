import {
  answersOf,
  boundedBlocks,
  defineFlow,
  othersOf,
  type Automation,
  type JsonObject,
  type InvokeRequest,
  type Manifest,
  type Step,
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
import { batchResult, childRequest, visitResult } from './v2/result.js';
import { categorize, chunk, organize, queue } from './v2/batch-steps.js';
import {
  checkVisit,
  lookUpNpi,
  matchVisit,
  rankCodes,
  readVisit,
  receiveVisit,
} from './v2/child-steps.js';
import { otherTitles } from './v2/review.js';
import { reviewVisit, saveVisit } from './v2/review-steps.js';
import { readChart } from './v6/chart-read.js';
import { writeChart } from './v6/chart-write.js';
import { neverHeld, readNotes, receiveChart } from './v6/hook-steps.js';
import { SKIPPED, byPath, isHookRun, withNotes } from './v6/paths.js';
import { hookResult, withChartNote } from './v6/result.js';

/** ICD-10 Code Check, on `defineFlow`: its spec is README.md beside src/. */
export const TEMPLATE_ID = 'icd10-code-check';

/**
 * The one version this image serves; its Dockerfile copies only its manifest. v1 to v5 are
 * retired (README, "Versions"), and their code here is unchanged, v6's runs reusing it: v3 is v2's
 * chain with its setup in sections and a change's "Other code" (README, "v3"); v4 is v3 carrying
 * health data, its calls naming no models (README, "v4"; `modelsFor`); v5 is v4 with its file
 * field required, so the platform refuses a run without a file before it starts (README, "v5");
 * v6 is v5 started by an upload or by the EHR's hook, its EHR connection optional (README, "v6";
 * `v6/`).
 */
export const SERVED_VERSIONS: readonly number[] = [6];

export { prompts };

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The flow, for the manifests given: v1's steps and v2's — its batch run's and its visit run's,
 * v3's to v6's the same — each only where a given manifest declares it, so the image (v6 alone)
 * and the suite (all six) build from one list; `match-codes` is v1's on a v1 run and `matchVisit`
 * on any later run. A v6 run the EHR's hook started takes its own path (`byPath`, `withNotes`;
 * README, "v6"): its notes read from the EHR in place of a file, no review and no save, its
 * result the card's codes; an upload's visit adds the chart note after its review. `options` are
 * for its suite: the day a run starts and the tables the build holds (`check-note`,
 * `check-visit`). Each AI step is run once more on a failure that decided nothing (README,
 * "Retrying a step"): `settle` rethrows while a repeat is left, and never once a model answered.
 */
export function define(
  manifests: readonly Manifest[],
  options: Partial<CheckNoteOptions> = {},
): Automation {
  const dated = { today: options.today ?? today, tables: options.tables ?? TABLES };
  const match: Step = (context) =>
    context.request.templateVersion === 1 ? matchCodes(context) : matchVisit(context);
  const all: Record<string, Step> = {
    receive,
    'read-note': readNote,
    'check-note': checkNote(dated),
    'find-codes': findCodes,
    'match-codes': withNotes(match),
    'check-codes': withNotes(checkCodes),
    decide,
    save,
    chunk,
    categorize,
    organize,
    queue,
    'receive-visit': byPath(receiveVisit, receiveChart),
    'read-chart': readChart,
    'look-up-npi': withNotes(lookUpNpi),
    'read-visit': withNotes(readVisit, readNotes),
    'check-visit': withNotes(checkVisit(dated), neverHeld(checkVisit(dated))),
    'rank-codes': withNotes(rankCodes),
    'review-visit': byPath(reviewVisit, SKIPPED),
    'save-visit': byPath(saveVisit, SKIPPED),
    'write-chart': writeChart,
  };
  const declared = new Set(
    manifests.flatMap((m) => [...m.pipeline, ...(m.batch?.pipeline ?? [])].map((s) => s.id)),
  );
  const retry = {
    'read-note': { attempts: 2, backoffMs: 10_000 },
    'match-codes': { attempts: 2, backoffMs: 10_000 },
    'read-visit': { attempts: 2, backoffMs: 10_000 },
    categorize: { attempts: 2, backoffMs: 10_000 },
  };
  return defineFlow({
    templateId: TEMPLATE_ID,
    manifests,
    prompts,
    steps: Object.fromEntries(Object.entries(all).filter(([id]) => declared.has(id))),
    retry: Object.fromEntries(Object.entries(retry).filter(([id]) => declared.has(id))),
    result: (state, request) =>
      request.templateVersion === 1
        ? result(state, request)
        : request.batch === true
          ? batchResult(state)
          : isHookRun(request)
            ? hookResult(visitResult(result(state, request), state), state)
            : withChartNote(visitResult(result(state, childRequest(request)), state), state),
  });
}

/**
 * What a run gives (the spec, section 7): its title, summary, blocks and output; never `documents`.
 * On v3, another code picked in a change's place counts with the accepted (`doneBlocks`) and is
 * entered with its title (`otherTitles`).
 */
function result(state: JsonObject, request: InvokeRequest) {
  const read = viewOf(state);
  const view = { ...read, titles: { ...otherTitles(state), ...read.titles } };
  const reading = readingOf(state.reading);
  const answers = answersOf(request);
  const others = othersOf(request);
  const reviewed = view.rows.some((r) => DECIDED.has(r.verdict));
  const codes = Array.isArray(state.finalCodes) ? (state.finalCodes as string[]) : [];
  const accepted = [...answers.values()].filter((answer) => answer !== 'denied').length;
  const n = view.rows.length;
  const summary = reviewed
    ? WORDS.summaryDone(n, accepted, answers.size - accepted)
    : view.asks.length === 0
      ? WORDS.summaryKept(n)
      : WORDS.summaryHeld(n, view.asks.length);
  const blocks = boundedBlocks(
    reviewed ? doneBlocks(view, answers, codes, others) : keptBlocks(view),
  );
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
