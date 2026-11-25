import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOW_WORDS, type JsonObject, type RunResult } from '@autom8x/automation-sdk';

import { WORDS } from '../src/words.js';
import { ICD10_CM } from '../src/v6/codes.js';
import { htmlText, NOTE_CHARS } from '../src/v6/note-text.js';
import { reading } from './fixtures.js';
import {
  VISIT,
  binaries,
  binary,
  bundle,
  docRef,
  ehrCalls,
  ehrPlatform,
  hookInvoke,
  runHook,
  type EhrAnswers,
} from './v6-fixtures.js';

/**
 * v6's hook path (README, "v6", row 3; the platform's ADR-0053 point 5 and ADR-0051 Amendment 2):
 * a run the EHR's hook started reads its visit's notes from the EHR — `notes.search` by patient and
 * encounter, then each note's text by `binary.read` — feeds the text to v5's code finding, and
 * gives `output.diagnosisCodes`, exactly the shape the platform's card reads; no hold, no review,
 * no save, no mail. Every patient, note and id here is made up.
 */

const note = reading(
  [],
  [
    { statement: 'Hypertension', categories: ['I10'] },
    { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
  ],
);
const picks = { CKD: { code: 'N18.31' }, Hypertension: { code: 'I10' } };
const TEXT = 'Assessment: Hypertension. CKD stage 3a, eGFR 52 today. Plan: recheck in 3 months.';

const oneNote = (contentType = 'text/plain', text = TEXT): EhrAnswers => ({
  'notes.search': () => ({ status: 200, body: bundle([docRef([[contentType, 'b1']])]) }),
  'binary.read': binaries({ b1: binary(contentType, text) }),
});

/**
 * The platform's card reader, restated (`snoopy-backend/apps/runs/src/cds-hooks-card.ts`,
 * `cardCodes`, at 6cc381f): 1 to 12 entries of exactly four keys, an ICD-10-CM code each once,
 * the system, a one-line display of at most 300 and a one-line reason of at most 200.
 */
function cardTakes(output: unknown): boolean {
  const listed = (output as JsonObject | undefined)?.diagnosisCodes;
  if (!Array.isArray(listed) || listed.length < 1 || listed.length > 12) return false;
  const line = (value: unknown, max: number) =>
    typeof value === 'string' && value.length <= max && /^[^\p{Cc}]+$/u.test(value);
  const seen = new Set<string>();
  return listed.every((entry) => {
    const e = entry as JsonObject;
    const ok =
      Object.keys(e).length === 4 &&
      e.system === ICD10_CM &&
      typeof e.code === 'string' &&
      /^[A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/u.test(e.code) &&
      !seen.has(e.code) &&
      line(e.display, 300) &&
      line(e.reason, 200);
    if (typeof e.code === 'string') seen.add(e.code);
    return ok;
  });
}

const output = (result: RunResult): JsonObject =>
  (result as Extract<RunResult, { outcome: 'success' }>).output as JsonObject;

test("a visit's note read from the EHR gives the card its codes, each with its name and why", async () => {
  const { result, platform } = await runHook(ehrPlatform(note, picks, oneNote()));
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  assert.deepEqual(
    ehrCalls(platform).map((call) => [call.operation, call.input]),
    [
      ['notes.search', { patient: VISIT.patientId, encounter: VISIT.encounterId }],
      ['binary.read', { binaryId: 'b1' }],
    ],
  );
  const read = platform.modelCalls[0]!;
  assert.equal(read.capability, 'document-extraction');
  assert.equal(read.artifactId, undefined, 'the text, never a file');
  assert.equal(read.input.noteText, TEXT);
  for (const call of platform.modelCalls) {
    assert.equal(call.models, undefined, 'a health version names no models (HEALTH_VERSIONS)');
  }
  assert.ok(cardTakes(output(result)), JSON.stringify(output(result).diagnosisCodes));
  assert.deepEqual(
    (output(result).diagnosisCodes as JsonObject[]).map((one) => [one.code, one.display]),
    [
      [
        'I12.9',
        'Hypertensive chronic kidney disease with stage 1 through stage 4 chronic kidney disease, or unspecified chronic kidney disease',
      ],
      ['N18.31', 'Chronic kidney disease, stage 3a'],
    ],
  );
  assert.equal(
    (output(result).diagnosisCodes as JsonObject[])[1]!.reason,
    'From the note: "CKD stage 3a, eGFR 52 today" · Rule: code what the note supports',
  );
  assert.equal((result as { summary?: string }).summary, '2 codes suggested in your EHR');
});

test('no hold, no review, no save, no mail: the clinician’s tick on the card is the approval', async () => {
  const { result, platform } = await runHook(ehrPlatform(note, picks, oneNote()));
  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    [
      'receive-visit',
      'read-chart',
      'read-visit',
      'check-visit',
      'rank-codes',
      'match-codes',
      'check-codes',
    ],
  );
  assert.ok(platform.steps.every((step) => step.outcome === 'ok'));
  assert.deepEqual(platform.mails, []);
  assert.equal(platform.memory.values.size, 0, "the clinic's memory is not written");
  assert.ok(!ehrCalls(platform).some((call) => call.operation === 'notes.create'));
});

test('a visit with no note: succeeded, no codes, no AI call', async () => {
  const platform = ehrPlatform(note, picks, {
    'notes.search': () => ({ status: 200, body: bundle([]) }),
  });
  const { result } = await runHook(platform);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(output(result).diagnosisCodes, []);
  assert.equal(cardTakes(output(result)), false, 'no card');
  assert.deepEqual(platform.modelCalls, []);
  assert.equal((result as { summary?: string }).summary, 'No visit note read');
});

test('a note read but no code found: succeeded, no codes', async () => {
  const none = reading([], [{ statement: 'Seen for a check-up', categories: ['Z00'] }]);
  const { result } = await runHook(ehrPlatform(none, {}, oneNote()));
  assert.equal(result.outcome, 'success');
  assert.deepEqual(output(result).diagnosisCodes, []);
});

test('an HTML note is read with its tags stripped, its entities read, a line a paragraph', async () => {
  const html =
    '<html><head><title>Visit</title><style>p{color:red}</style></head><body>' +
    '<p>Assessment:</p><p>Hypertension &amp; CKD stage 3a,<br>eGFR 52&nbsp;today.</p>' +
    '<script>alert(1)</script><!-- a comment --></body></html>';
  const { platform } = await runHook(ehrPlatform(note, picks, oneNote('text/html', html)));
  assert.equal(
    platform.modelCalls[0]!.input.noteText,
    'Assessment:\nHypertension & CKD stage 3a,\neGFR 52 today.',
  );
  assert.equal(htmlText('<b>A</b>&lt;b&gt; &#65;&#x42;<i>C</i>'), 'A <b> AB C');
});

test('a note in another type, status or with no content is skipped, its reason kept', async () => {
  const platform = ehrPlatform(note, picks, {
    'notes.search': () => ({
      status: 200,
      body: bundle([
        docRef([['text/rtf', 'r1']]),
        docRef([['text/plain', 'x1']], 'entered-in-error'),
        docRef([
          ['text/rtf', 'r2'],
          ['text/html', 'h1'],
        ]),
        docRef([['text/plain', 'gone']]),
        docRef([['text/plain', 'pdf1']]),
      ]),
    }),
    'binary.read': binaries({
      h1: binary('text/html', `<p>${TEXT}</p>`),
      pdf1: binary('application/pdf', '%PDF-1.7'),
    }),
  });
  const { result } = await runHook(platform);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    ehrCalls(platform).map((call) => call.input.binaryId ?? call.operation),
    ['notes.search', 'h1', 'gone', 'pdf1'],
    'an RTF-only note and one entered in error are never fetched',
  );
  assert.deepEqual((output(result).measures as JsonObject).notes, {
    found: 5,
    read: 1,
    skipped: [
      'type text/rtf',
      'status entered-in-error',
      'not read: refused',
      'type application/pdf',
    ],
    cut: 0,
  });
  assert.equal(platform.modelCalls[0]!.input.noteText, TEXT);
});

test('a long note is cut at the bound; a note given inline needs no Binary read', async () => {
  const long = `${TEXT} ${'x'.repeat(NOTE_CHARS)}`;
  const inline = {
    resourceType: 'DocumentReference',
    status: 'current',
    content: [
      {
        attachment: {
          contentType: 'text/plain; charset=utf-8',
          data: Buffer.from(long, 'utf8').toString('base64'),
        },
      },
    ],
  };
  const platform = ehrPlatform(note, picks, {
    'notes.search': () => ({ status: 200, body: bundle([inline]) }),
  });
  const { result } = await runHook(platform);
  assert.equal(result.outcome, 'success');
  assert.deepEqual(
    ehrCalls(platform).map((call) => call.operation),
    ['notes.search'],
  );
  assert.equal((platform.modelCalls[0]!.input.noteText as string).length, NOTE_CHARS);
  assert.equal(((output(result).measures as JsonObject).notes as JsonObject).cut, 1);
});

test('the EHR not picked in setup: no EHR call, no codes', async () => {
  const platform = ehrPlatform(note, picks, oneNote());
  const { result } = await runHook(
    platform,
    hookInvoke({ specialties: ['207RN0300X'], ehr: 'none' }),
  );
  assert.equal(result.outcome, 'success');
  assert.deepEqual(ehrCalls(platform), []);
  assert.deepEqual(output(result).diagnosisCodes, []);
});

test("the EHR refusing the notes' search fails the run in the SDK's words: no card", async () => {
  const platform = ehrPlatform(note, picks, {
    'notes.search': () => ({ status: 403, body: { resourceType: 'OperationOutcome' } }),
  });
  const { result } = await runHook(platform);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.vendor_refused });
  assert.deepEqual(platform.modelCalls, []);
});

test('an answer that is no FHIR Bundle fails the run in its own words', async () => {
  const platform = ehrPlatform(note, picks, {
    'notes.search': () => ({ status: 200, body: { error: 'not JSON' } }),
  });
  const { result } = await runHook(platform);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: "The visit's notes could not be read from your EHR.",
  });
});

test('a hook run never holds: a visit whose table this build lacks stops instead', async () => {
  const april = reading([], [{ statement: 'CKD stage 3a', categories: ['N18'] }], {
    visitDate: '2026-05-04',
  });
  const platform = ehrPlatform(april, { CKD: { code: 'N18.31' } }, oneNote());
  const { result } = await runHook(platform, hookInvoke(), ['2026-oct', '2027-oct']);
  assert.deepEqual(result, { outcome: 'failed', failureReason: WORDS.aprilHold });
  assert.ok(platform.steps.every((step) => step.outcome !== 'held'));
});

test('a card offers at most 12 codes, and none the checks leave to the doctor', async () => {
  const found = ['R00.0', 'R00.1', 'R00.2', 'R00.8', 'R01.1', 'R03.0', 'R04.0', 'R04.2']
    .concat(['R05.1', 'R06.02', 'R07.9', 'R10.9', 'R11.0', 'R42'])
    .map((code, at) => ({ code, statement: `Sign ${at + 1} noted` }));
  const many = reading(
    ['I10', 'E11.9'],
    [
      { statement: 'Hypertension', categories: ['I10'] },
      ...found.map(({ code, statement }) => ({ statement, categories: [code.slice(0, 3)] })),
    ],
  );
  const chosen = Object.fromEntries(found.map(({ code, statement }) => [statement, { code }]));
  const { result } = await runHook(
    ehrPlatform(many, { ...chosen, Hypertension: { code: 'I10' } }, oneNote()),
  );
  const codes = (output(result).diagnosisCodes as JsonObject[]).map((one) => one.code);
  assert.equal(codes.length, 12, JSON.stringify(codes));
  assert.deepEqual(codes.slice(0, 2), ['I10', 'R00.0'], "the chart's order: the note's code first");
  assert.ok(!codes.includes('E11.9'), 'a code no line supports is an ask, never offered');
  assert.ok(cardTakes(output(result)));
});
