import { join, resolve } from 'node:path';

import {
  readManifests,
  type InvokeRequest,
  type JsonObject,
  type RunResult,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  answerReview,
  artifactFixture,
  invokeFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import type { CheckNoteOptions } from '../src/steps/check-note.js';

/**
 * The suite's made-up visits (no real patient, no real chart): a note's reading as `read-note`
 * would answer it, and the code `match-codes` would pick for each statement, answered by number
 * from the list the flow sent — as the model must — with its quote.
 */
/** The note's upload id: an upload id's shape, as the platform's model call requires. */
export const NOTE_ID = '33333333-3333-4333-8333-333333333333';

export const flow = resolve(import.meta.dirname, '..');
export const manifests = readManifests(join(flow, '..', '..', 'manifests'), TEMPLATE_ID);

export interface Dx {
  statement: string;
  categories: string[];
  certainty?: 'confirmed' | 'uncertain';
  byProvider?: boolean;
  thisVisit?: boolean;
  evidence?: string | null;
  unrelatedTo?: number[];
}

export function reading(codes: string[], diagnoses: Dx[], extra: JsonObject = {}): JsonObject {
  return {
    isVisitNote: true,
    readable: true,
    patientCount: 1,
    patient: {
      name: 'Jane Doe',
      birthDate: null,
      sex: null,
      recordNumber: null,
      provider: 'Dr. Alan Smith',
    },
    visitDate: '2026-10-12',
    codesOnNote: codes,
    diagnoses: diagnoses.map((d) => ({
      statement: d.statement,
      certainty: d.certainty ?? 'confirmed',
      byProvider: d.byProvider ?? true,
      thisVisit: d.thisVisit ?? true,
      evidence: d.evidence ?? null,
      unrelatedTo: d.unrelatedTo ?? [],
      categories: d.categories,
    })),
    otherIdentifiers: [],
    directions: [],
    ...extra,
  };
}

/** For each statement, the code to pick and the quote to give; a statement left out picks 0. */
export type Picks = Record<string, { code: string; quote?: string }>;

interface SentDiagnosis {
  diagnosis: number;
  statement: string;
  candidates: { number: number; code: string }[];
}

export function platformFor(note: JsonObject, picks: Picks = {}): RecordingPlatform {
  const platform = new RecordingPlatform();
  platform.artifacts = [
    artifactFixture({ artifactId: NOTE_ID, filename: 'visit.pdf', contentType: 'application/pdf' }),
  ];
  platform.model = (call, model) => {
    const answer =
      call.capability === 'document-extraction'
        ? note
        : {
            matches: ((call.input.diagnoses ?? []) as SentDiagnosis[]).map((sent) => {
              const pick = Object.entries(picks).find(([statement]) =>
                sent.statement.includes(statement),
              )?.[1];
              const listed = sent.candidates.find((candidate) => candidate.code === pick?.code);
              return {
                diagnosis: sent.diagnosis,
                choice: listed?.number ?? 0,
                quote: listed === undefined ? '' : (pick?.quote ?? sent.statement),
              };
            }),
          };
    return Promise.resolve({
      text: JSON.stringify(answer),
      model,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  return platform;
}

export function request(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    input: { visitNote: NOTE_ID },
    config: { specialties: ['Nephrology'] },
    ...overrides,
  });
}

export interface Ran {
  result: RunResult;
  platform: RecordingPlatform;
  request: InvokeRequest;
}

export async function run(
  note: JsonObject,
  picks: Picks = {},
  options: {
    specialties?: string[];
    flow?: Partial<CheckNoteOptions>;
    platform?: RecordingPlatform;
  } = {},
): Promise<Ran> {
  const platform = options.platform ?? platformFor(note, picks);
  const invoke = request({ config: { specialties: options.specialties ?? ['Nephrology'] } });
  const result = await define(manifests, { today: () => '2026-10-28', ...options.flow }).execute(
    invoke,
    platform,
  );
  // As the serving shell reports it: bounded as the platform takes it (`boundedResult`).
  await platform.reportResult(invoke.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request: invoke };
}

/** The review answered, and the run continued on a fresh platform. */
export async function review(
  ran: Ran,
  answers: Record<string, 'accepted' | 'denied'>,
): Promise<Ran> {
  const continued = answerReview(ran.platform, ran.request, answers);
  const platform = new RecordingPlatform();
  const result = await define(manifests, { today: () => '2026-10-28' }).execute(
    continued,
    platform,
  );
  await platform.reportResult(continued.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request: continued };
}

/** The rows of a held or finished run: [code, verdict, suggested, check]. */
export function rowsOf(result: RunResult): [string, string, string | null, string][] {
  const state =
    result.outcome === 'held'
      ? result.held.state
      : result.outcome === 'success'
        ? { rows: (result.output?.verdicts as JsonObject[]) ?? [] }
        : { rows: [] };
  return ((state.rows ?? []) as JsonObject[]).map((r) => [
    String(r.code),
    String(r.verdict),
    (r.suggested as string | null) ?? null,
    String(r.check),
  ]);
}

/** The asks of a held run, or of a finished one's blocks. */
export function asksOf(
  result: RunResult,
): { title: string; reason: string | null; check: string }[] {
  return result.outcome === 'held' ? ((result.held.state.asks ?? []) as never[]) : [];
}

/** Every string a person may read in a result: its blocks, its summary and its reasons. */
export function wordsOf(result: RunResult): string {
  return JSON.stringify(result);
}
