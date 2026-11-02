import type { InvokeRequest, JsonObject, ModelRequest, RunResult } from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  answerReview,
  artifactFixture,
  invokeFixture,
  unitFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { NOTE_ID, manifests, platformFor, type Picks } from './fixtures.js';

/**
 * v2's made-up runs (no real patient): a batch run over an upload, each page sorted as the model
 * would answer `categorize-pages`; and a visit's child run, its unit's pages read as `read-note`
 * would answer them (`platformFor`, v1's fixture).
 */

export const PDF_ID = '44444444-4444-4444-8444-444444444441';
export const PHOTO_ID = '44444444-4444-4444-8444-444444444442';

/** One page as the model sorts it: one segment, or (`also`) more, top to bottom. */
export const page = (
  number: number,
  kind: 'note' | 'lab' | 'cover' | 'separator' | 'other',
  patient: string | null = null,
  visitDate: string | null = null,
  position: number | null = null,
  also: {
    kind: 'note' | 'lab';
    patient: string | null;
    visitDate: string | null;
    position: number | null;
  }[] = [],
) => ({ page: number, segments: [{ kind, patient, visitDate, position }, ...also] });

/** A batch run's platform: its files, and per file the pages the model answers, by page number. */
export function batchPlatform(
  files: { id: string; contentType: string; pageCount: number | null; sha256?: string }[],
  sorted: Record<string, ReturnType<typeof page>[]>,
  bytes: Uint8Array = new Uint8Array(),
): RecordingPlatform {
  const platform = new RecordingPlatform();
  platform.artifacts = files.map((file) =>
    artifactFixture({
      artifactId: file.id,
      contentType: file.contentType,
      pageCount: file.pageCount,
      sha256: file.sha256 ?? file.id,
    }),
  );
  platform.bytes = () => bytes;
  platform.model = (call: ModelRequest, model) => {
    const pages = (sorted[call.artifactId ?? ''] ?? []).filter(
      (one) =>
        call.pages === undefined || (one.page >= call.pages.from && one.page <= call.pages.to),
    );
    return Promise.resolve({
      text: JSON.stringify({ pages }),
      model,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  return platform;
}

/** A batch run's invoke, the upload's files under `visitNotes`. */
export const batchRequest = (ids: string[]): InvokeRequest =>
  invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 2,
    batch: true,
    input: { visitNotes: ids },
  });

/** A visit's child run: its unit's pieces (each two pages of the note; one by default) and its setup. */
export const childInvoke = (config: JsonObject = {}, pieces = 1): InvokeRequest =>
  invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 2,
    config,
    unit: unitFixture({
      label: 'Jane Doe · Oct 12, 2026',
      artifacts: Array.from({ length: pieces }, (_, i) => ({
        artifactId: NOTE_ID,
        pages: { from: 2 * i + 1, to: 2 * i + 2 },
      })),
      data: { patient: 'Jane Doe', visitDate: '2026-10-12', pages: 2 * pieces },
    }),
  });

export interface ChildRan {
  result: RunResult;
  platform: RecordingPlatform;
  request: InvokeRequest;
}

const flow = () => define(manifests, { today: () => '2026-10-28' });

/** A child run on `platform` (default: `platformFor(note, picks)`), its result bounded as sent. */
export async function runChild(
  note: JsonObject,
  picks: Picks = {},
  options: { config?: JsonObject; platform?: RecordingPlatform; pieces?: number } = {},
): Promise<ChildRan> {
  const platform = options.platform ?? platformFor(note, picks);
  const request = childInvoke(options.config ?? { specialties: ['207RN0300X'] }, options.pieces);
  const result = await flow().execute(request, platform);
  await platform.reportResult(request.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request };
}

/** The review answered and the child continued on a platform keeping the same memory. */
export async function reviewChild(
  ran: ChildRan,
  answers: Record<string, 'accepted' | 'denied'>,
  note: JsonObject,
): Promise<ChildRan> {
  const next = answerReview(ran.platform, ran.request, answers);
  const platform = platformFor(note);
  platform.memory = ran.platform.memory;
  const result = await flow().execute(next, platform);
  await platform.reportResult(next.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request: next };
}
