import { Buffer } from 'node:buffer';

import type {
  InvokeRequest,
  JsonObject,
  ProviderAnswer,
  ProviderRequest,
  RunResult,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  answerReview,
  invokeFixture,
  type ReviewAnswer,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import type { TableId } from '../src/tables.js';
import { manifests, platformFor, type Picks } from './fixtures.js';
import { childInvoke } from './v2-fixtures.js';

/**
 * v6's made-up runs (no real patient, no real chart): a run the EHR's hook started, its visit's
 * notes answered as a FHIR R4 server would (`ehrAnswers`), and an upload's visit run with the EHR
 * picked, its review answered and the chart note's searches and write answered.
 */

/** The made-up visit a hook names: FHIR ids, never a real patient's. */
export const VISIT = { patientId: 'ePatient-1', encounterId: 'eVisit-1' };

/** A hook run's invoke: its trigger, the hook's `context`, and `startedBy` (ADR-0053 point 5). */
export function hookInvoke(
  config: JsonObject = { specialties: ['207RN0300X'], ehr: 'ehr-fhir' },
  context: JsonObject = { ...VISIT, userId: 'Practitioner/ePractitioner-1' },
): InvokeRequest {
  const invoke = invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 6,
    config,
    input: {
      trigger: {
        kind: 'provider-event',
        connection: 'ehr-fhir',
        hook: 'patient-view',
        hookInstance: 'd1577c69-dfbe-44ad-ba6d-3e05e953b2ea',
      },
      context,
    },
  });
  return { ...invoke, startedBy: 'provider-event' } as InvokeRequest;
}

/** A FHIR searchset Bundle of `resources`. */
export const bundle = (resources: JsonObject[], extra: JsonObject = {}): JsonObject => ({
  resourceType: 'Bundle',
  type: 'searchset',
  total: resources.length,
  entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
  ...extra,
});

/** A note, `current` unless told, with one attachment per `[contentType, binaryId]`. */
export const docRef = (
  attachments: [string, string][],
  status = 'current',
  id = `note-${attachments[0]?.[1] ?? 'none'}`,
): JsonObject => ({
  resourceType: 'DocumentReference',
  id,
  status,
  content: attachments.map(([contentType, binaryId]) => ({
    attachment: { contentType, url: `Binary/${binaryId}` },
  })),
});

/** A Binary resource as Epic answers `binary.read` with JSON asked for: its type and base64 data. */
export const binary = (contentType: string, text: string): JsonObject => ({
  resourceType: 'Binary',
  contentType,
  data: Buffer.from(text, 'utf8').toString('base64'),
});

/** What the EHR answers each operation, by operation; anything not given answers 404. */
export type EhrAnswers = Partial<
  Record<string, (call: ProviderRequest) => ProviderAnswer | undefined>
>;

/** A platform reading `note` and picking `picks`, its EHR answering as `answers` say. */
export function ehrPlatform(
  note: JsonObject,
  picks: Picks,
  answers: EhrAnswers,
): RecordingPlatform {
  const platform = platformFor(note, picks);
  platform.provider = (call) =>
    Promise.resolve(answers[call.operation]?.(call) ?? { status: 404, body: null });
  return platform;
}

/** The binary answer for each Binary id. */
export const binaries =
  (byId: Record<string, JsonObject>) =>
  (call: ProviderRequest): ProviderAnswer => {
    const found = byId[String(call.input.binaryId)];
    return found === undefined ? { status: 404, body: null } : { status: 200, body: found };
  };

const flow = (tables?: readonly TableId[]) =>
  define(manifests, { today: () => '2026-10-28', ...(tables === undefined ? {} : { tables }) });

export interface Ran {
  result: RunResult;
  platform: RecordingPlatform;
  request: InvokeRequest;
}

/** A hook run on `platform`, its result bounded as sent. */
export async function runHook(
  platform: RecordingPlatform,
  invoke: InvokeRequest = hookInvoke(),
  tables?: readonly TableId[],
): Promise<Ran> {
  const result = await flow(tables).execute(invoke, platform);
  await platform.reportResult(invoke.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request: invoke };
}

/** An upload's v6 visit run with the EHR picked (or `config`), on `platform`. */
export async function runVisit(
  platform: RecordingPlatform,
  config: JsonObject = { specialties: ['207RN0300X'], ehr: 'ehr-fhir' },
): Promise<Ran> {
  const invoke = { ...childInvoke(config, 1, 6), startedBy: 'manual' } as InvokeRequest;
  const result = await flow().execute(invoke, platform);
  await platform.reportResult(invoke.runId, result);
  return { result: platform.results.at(-1)!.result, platform, request: invoke };
}

/** The review answered and the visit continued on `next`, which keeps the first's memory. */
export async function continueVisit(
  ran: Ran,
  answers: Record<string, ReviewAnswer>,
  next: RecordingPlatform,
): Promise<Ran> {
  const invoke = answerReview(ran.platform, ran.request, answers);
  next.memory = ran.platform.memory;
  const result = await flow().execute(invoke, next);
  await next.reportResult(invoke.runId, result);
  return { result: next.results.at(-1)!.result, platform: next, request: invoke };
}

/** The EHR's calls a platform was asked, as `operation`. */
export const ehrCalls = (platform: RecordingPlatform): ProviderRequest[] =>
  platform.providerCalls.filter((call) => call.providerId === 'ehr-fhir');
