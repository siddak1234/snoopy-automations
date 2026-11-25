import {
  isObject,
  optionalConnection,
  settle,
  type InvokeRequest,
  type SettleKind,
  type JsonObject,
  type Step,
  type StepResult,
} from '@autom8x/automation-sdk';

import { readingOf } from '../reading.js';
import { realDate } from '../tables.js';
import { viewOf } from '../view.js';
import { otherTitles } from '../v2/review.js';
import { visitAnswers, visitOthers } from '../v2/review-steps.js';
import { RECORD_NUMBER, chartNote, patientSearch, visitSearch } from './chart-note.js';
import { visitCodes } from './codes.js';
import { onlyMatch } from './fhir.js';
import { EHR, EHR_FIELD, SKIPPED, byPath } from './paths.js';
import { NOT_WRITTEN, WORDS_V6 } from './words.js';

/**
 * Note added to your EHR (README, "v6", row 4; BUILD-PLAN 30.21.5, U44, the session's safety
 * default): on an upload's visit run with the EHR picked, and only once the person answered the
 * review (`review-visit`'s approval), one chart note listing the approved codes, each with its
 * name and the line on why (`visitCodes`). Only to one patient found by the note's record number
 * and one of that patient's visits on the note's date, each found exactly; otherwise nothing is
 * written, and the visit's outcome says why — never a patient detail: a call the EHR refused or
 * did not answer ends the step, the run going on with its codes saved (`settle`; the EHR not
 * connected, `optionalConnection`'s line). A hook run, or the EHR not picked, skips the step: no
 * EHR call.
 */

/** A visit's chart note outcome, the run's `output.chartNote`. */
export type ChartOutcome = { outcome: 'written' } | { outcome: 'not written'; reason: string };

/** Whether the run continues the person's answers to `review-visit`: the review's approval. */
export function reviewed(request: InvokeRequest): boolean {
  const continuation = request.continuation;
  return (
    continuation?.kind === 'approval' &&
    continuation.stepId === 'review-visit' &&
    continuation.decision === 'approved' &&
    (continuation.decisions?.length ?? 0) > 0
  );
}

const kept = (state: JsonObject, chart: ChartOutcome, step: 'ok' | 'failed'): StepResult => ({
  outcome: step,
  summary: chart.outcome === 'written' ? WORDS_V6.written : WORDS_V6.notWritten(chart.reason),
  state: { ...state, chartNote: { ...chart } },
});

const not = (state: JsonObject, reason: string, step: 'ok' | 'failed' = 'ok') =>
  kept(state, { outcome: 'not written', reason }, step);

/** Why a call of the write gave no answer, by `settle`'s kind: never the EHR's own words. */
const REASONS: Partial<Record<SettleKind, string>> = {
  not_connected: NOT_WRITTEN.notConnected,
  vendor_refused: NOT_WRITTEN.refused,
  unconfirmed: NOT_WRITTEN.unconfirmed,
};

export const writeChart: Step = byPath(async (context) => {
  const { request, state } = context;
  const ehr = optionalConnection(context, EHR_FIELD, EHR);
  if (!ehr.chosen) return { outcome: 'skipped' };
  if (!reviewed(request)) return not(state, NOT_WRITTEN.notApproved);
  const view = viewOf(state);
  const titles = { ...otherTitles(state), ...view.titles };
  const codes = visitCodes(
    view.rows,
    visitAnswers(request),
    titles,
    view.tableName,
    visitOthers(request),
    Number.POSITIVE_INFINITY,
  );
  if (codes.length === 0) return not(state, NOT_WRITTEN.noCodes);
  const recordNumber = readingOf(state.reading).patient.recordNumber?.trim() ?? '';
  if (recordNumber === '') return not(state, NOT_WRITTEN.noRecordNumber);
  if (!RECORD_NUMBER.test(recordNumber)) return not(state, NOT_WRITTEN.recordNumberUnusable);
  const visitDate = realDate(state.visitDate);
  if (visitDate === undefined) return not(state, NOT_WRITTEN.noVisitDate);

  /** One call of the write through `settle`: its 2xx answer, or the step's end, the run going on. */
  const ask = async (
    operation: 'patients.search' | 'encounters.search' | 'notes.create',
    input: JsonObject,
    part: string,
  ): Promise<{ body: unknown } | { end: StepResult }> => {
    const asked = await settle(context, () =>
      context.platform.callProvider({ providerId: EHR, operation, input }, { part }),
    );
    if (asked.ok) return asked.value;
    const reason = REASONS[asked.kind] ?? NOT_WRITTEN.noAnswer;
    const chart: ChartOutcome = { outcome: 'not written', reason };
    return {
      end:
        asked.kind === 'not_connected'
          ? ehr.notConnected('EHR', { ...state, chartNote: { ...chart } })
          : kept(state, chart, 'failed'),
    };
  };

  const patients = await ask('patients.search', patientSearch(recordNumber), 'patient');
  if ('end' in patients) return patients.end;
  const patient = onlyMatch(patients.body, 'Patient');
  if (patient === undefined) return not(state, NOT_WRITTEN.patientNotMatched);
  const patientId = patient.id as string;

  const visits = await ask('encounters.search', visitSearch(patientId, visitDate), 'visit');
  if ('end' in visits) return visits.end;
  const visit = onlyMatch(visits.body, 'Encounter');
  const subject = isObject(visit?.subject) ? visit.subject.reference : undefined;
  if (visit === undefined || (subject !== undefined && subject !== `Patient/${patientId}`)) {
    return not(state, NOT_WRITTEN.visitNotMatched);
  }

  const created = await ask(
    'notes.create',
    chartNote(patientId, visit.id as string, codes),
    'note',
  );
  if ('end' in created) return created.end;
  return kept(state, { outcome: 'written' }, 'ok');
}, SKIPPED);
