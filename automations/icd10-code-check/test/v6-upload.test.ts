import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { notSentLine, type JsonObject, type RunResult } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { NOTE_CATEGORY, NOTE_CONTENT_TYPE, NOTE_TYPE } from '../src/v6/chart-note.js';
import { reading } from './fixtures.js';
import {
  bundle,
  continueVisit,
  ehrCalls,
  ehrPlatform,
  runVisit,
  type EhrAnswers,
  type Ran,
} from './v6-fixtures.js';

/**
 * v6's upload with the EHR picked (README, "v6", row 4; BUILD-PLAN 30.21.5, U44, the session's
 * safety default): v5's run unchanged, then — only after the person's review — one chart note per
 * visit, only to one patient matched by the note's record number and one of that patient's visits
 * on the note's date. Never before the review, never to a match that is not exact, never with the
 * EHR not picked. Every patient, record number and id here is made up.
 */

const PATIENT = {
  name: 'Jane Doe',
  birthDate: null,
  sex: null,
  recordNumber: '000123',
  provider: null,
};
const visitNote = (patient: JsonObject = PATIENT, visitDate: string | null = '2026-10-12') =>
  reading(
    ['I10', 'N18.30'],
    [
      { statement: 'Hypertension', categories: ['I10'] },
      { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
    ],
    { patient, visitDate },
  );
const picks = { CKD: { code: 'N18.31' } };

const patient = (id: string) => ({ resourceType: 'Patient', id });
const encounter = (id: string, of = 'p1') => ({
  resourceType: 'Encounter',
  id,
  subject: { reference: `Patient/${of}` },
});

/** The EHR's answers: the patients and the encounters found, and the write's answer. */
const ehr = (
  patients: JsonObject[] = [patient('p1')],
  encounters: JsonObject[] = [encounter('e1')],
  create: { status: number; body: unknown } = { status: 201, body: null },
): EhrAnswers => ({
  'patients.search': () => ({ status: 200, body: bundle(patients) }),
  'encounters.search': () => ({ status: 200, body: bundle(encounters) }),
  'notes.create': () => create,
});

const output = (result: RunResult): JsonObject =>
  (result as Extract<RunResult, { outcome: 'success' }>).output as JsonObject;

/** The visit run held for its review, then answered every change accepted. */
async function reviewedVisit(
  answers: EhrAnswers = ehr(),
  note: JsonObject = visitNote(),
  config?: JsonObject,
): Promise<{ held: Ran; done: Ran }> {
  const held = await runVisit(ehrPlatform(note, picks, answers), config);
  assert.equal(held.result.outcome, 'held', JSON.stringify(held.result).slice(0, 200));
  const offered = (held.result as Extract<RunResult, { outcome: 'held' }>).held.decisions ?? [];
  const done = await continueVisit(
    held,
    Object.fromEntries(offered.map((one) => [one.id, 'accepted' as const])),
    ehrPlatform(note, picks, answers),
  );
  return { held, done };
}

test('an exact match: one note written after the review, the approved codes with their names and why', async () => {
  const { held, done } = await reviewedVisit();
  assert.deepEqual(ehrCalls(held.platform), [], 'nothing reaches the EHR before the review');
  assert.equal(done.result.outcome, 'success');
  assert.deepEqual(
    ehrCalls(done.platform).map((call) => [
      call.operation,
      call.input.identifier ?? call.input.date,
    ]),
    [
      ['patients.search', '000123'],
      ['encounters.search', '2026-10-12'],
      ['notes.create', undefined],
    ],
  );
  assert.deepEqual(ehrCalls(done.platform)[1]!.input, { patient: 'p1', date: '2026-10-12' });
  const { content, ...fields } = ehrCalls(done.platform)[2]!.input as JsonObject;
  assert.deepEqual(fields, {
    resourceType: 'DocumentReference',
    status: 'current',
    type: NOTE_TYPE,
    category: NOTE_CATEGORY,
    subject: { reference: 'Patient/p1' },
    context: { encounter: [{ reference: 'Encounter/e1' }] },
  });
  assert.equal(NOTE_TYPE.coding[0]!.code, '34109-9');
  assert.equal(NOTE_CATEGORY[0]!.coding[0]!.code, 'clinical-note');
  const [{ attachment }] = content as [{ attachment: JsonObject }];
  assert.equal(attachment.contentType, NOTE_CONTENT_TYPE);
  assert.equal(NOTE_CONTENT_TYPE, 'text/plain; charset=utf-8');
  const text = Buffer.from(String(attachment.data), 'base64').toString('utf8');
  assert.deepEqual(
    text.split('\n').map((line) => line.split(':')[0]),
    [
      'ICD-10 Code Check',
      '- I12.9 Hypertensive chronic kidney disease with stage 1 through stage 4 chronic kidney disease, or unspecified chronic kidney disease',
      '- N18.31 Chronic kidney disease, stage 3a',
    ],
  );
  assert.ok(text.includes('From the note: "CKD stage 3a, eGFR 52 today"'));
  assert.ok(!text.includes('Jane Doe') && !text.includes('000123'), 'no patient detail of ours');
  assert.deepEqual(output(done.result).chartNote, { outcome: 'written' });
  assert.deepEqual(output(done.result).finalCodes, ['I12.9', 'N18.31'], "v5's codes, unchanged");
});

for (const [what, answers, reason, calls] of [
  ['no patient found', ehr([]), 'patient not matched', ['patients.search']],
  [
    'two patients found',
    ehr([patient('p1'), patient('p2')]),
    'patient not matched',
    ['patients.search'],
  ],
  [
    'no visit that day',
    ehr(undefined, []),
    'visit not matched',
    ['patients.search', 'encounters.search'],
  ],
  [
    'two visits that day',
    ehr(undefined, [encounter('e1'), encounter('e2')]),
    'visit not matched',
    ['patients.search', 'encounters.search'],
  ],
  [
    "a visit of another patient's",
    ehr(undefined, [encounter('e1', 'p9')]),
    'visit not matched',
    ['patients.search', 'encounters.search'],
  ],
] as const) {
  test(`${what}: not written, and the visit says why`, async () => {
    const { done } = await reviewedVisit(answers);
    assert.equal(done.result.outcome, 'success', 'the codes are saved all the same');
    assert.deepEqual(
      ehrCalls(done.platform).map((call) => call.operation),
      calls,
    );
    assert.deepEqual(output(done.result).chartNote, { outcome: 'not written', reason });
    assert.equal(
      done.platform.steps.at(-1)!.summary,
      `Not added to your EHR: ${reason}`,
      'the timeline says it',
    );
  });
}

test('more patients than the page shows is no exact match', async () => {
  const answers = ehr();
  answers['patients.search'] = () => ({
    status: 200,
    body: bundle([patient('p1')], { total: 2 }),
  });
  const { done } = await reviewedVisit(answers);
  assert.deepEqual(output(done.result).chartNote, {
    outcome: 'not written',
    reason: 'patient not matched',
  });
});

test('the EHR not picked: v5 unchanged, no EHR call, no chart outcome', async () => {
  const { held, done } = await reviewedVisit(ehr(), visitNote(), { specialties: ['207RN0300X'] });
  assert.deepEqual([...ehrCalls(held.platform), ...ehrCalls(done.platform)], []);
  assert.equal(output(done.result).chartNote, undefined);
  assert.ok(!done.platform.steps.some((step) => step.stepId === 'write-chart'));
});

test('no write before the review: a visit with nothing to change is not written', async () => {
  const kept = reading(['N18.31'], [{ statement: 'CKD stage 3a', categories: ['N18'] }], {
    patient: PATIENT,
  });
  const ran = await runVisit(ehrPlatform(kept, { 'CKD stage 3a': { code: 'N18.31' } }, ehr()));
  assert.equal(ran.result.outcome, 'success', 'nothing to review: no hold');
  assert.deepEqual(ehrCalls(ran.platform), []);
  assert.deepEqual(output(ran.result).chartNote, {
    outcome: 'not written',
    reason: 'not approved',
  });
});

test('no record number, or no visit date, on the note: not written, no EHR call', async () => {
  for (const [note, reason] of [
    [visitNote({ ...PATIENT, recordNumber: null }), 'no record number'],
    [visitNote({ ...PATIENT, recordNumber: '0001|23' }), 'record number not usable'],
    [visitNote(PATIENT, null), 'no visit date'],
  ] as const) {
    const { done } = await reviewedVisit(ehr(), note);
    assert.deepEqual(ehrCalls(done.platform), [], reason);
    assert.deepEqual(output(done.result).chartNote, { outcome: 'not written', reason });
  }
});

test("the EHR refusing the note: not written, the run's codes saved", async () => {
  const { done } = await reviewedVisit(ehr(undefined, undefined, { status: 422, body: {} }));
  assert.equal(done.result.outcome, 'success');
  assert.deepEqual(output(done.result).chartNote, {
    outcome: 'not written',
    reason: 'your EHR refused it',
  });
  assert.equal(done.platform.steps.at(-1)!.outcome, 'failed');
});

test("the EHR not connected: the SDK's line, the run going on", async () => {
  // Connections' 404 for a connection the workspace lacks, as the client throws it.
  const { done } = await reviewedVisit({
    ...ehr(),
    'patients.search': () => {
      throw refusalFixture('provider', { status: 404, code: 'NOT_FOUND', detail: 'not found' });
    },
  });
  assert.equal(done.result.outcome, 'success');
  assert.equal(done.platform.steps.at(-1)!.summary, notSentLine('EHR'));
  assert.deepEqual(output(done.result).chartNote, {
    outcome: 'not written',
    reason: 'your EHR is not connected',
  });
});
