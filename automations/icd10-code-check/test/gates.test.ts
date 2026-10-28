import assert from 'node:assert/strict';
import { test } from 'node:test';

import { define } from '../src/automation.js';
import { FAILURES, WORDS } from '../src/words.js';
import { NOTE_ID, manifests, platformFor, reading, request, rowsOf, run } from './fixtures.js';

/**
 * Gate A and section 8's failures not in section 9's rows, and what each step reports: the run's
 * timeline is `receive`, `read-note`, `check-note`, `find-codes`, `match-codes`, `check-codes`,
 * `decide` and `save`, each under the spec's step id and with its title as the line.
 */

const ckd = reading(['N18.4'], [{ statement: 'CKD stage 4', categories: ['N18'] }]);

test('a run with no file stops at receive: "Add the visit note as a PDF or photo."', async () => {
  const platform = platformFor(ckd);
  const result = await define(manifests).execute(request({ input: {} }), platform);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.noFile });
  assert.deepEqual(
    platform.steps.map((s) => [s.stepId, s.outcome]),
    [['receive', 'failed']],
  );
  assert.equal(platform.modelCalls.length, 0);
});

test('a file that is not a visit note, and one with no patient, stop at check-note', async () => {
  for (const note of [
    { ...ckd, isVisitNote: false },
    { ...ckd, patientCount: 0 },
  ]) {
    const { result } = await run(note);
    assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.notVisitNote });
  }
});

test('more than 40 diagnoses stop; 40 go on', async () => {
  const many = (n: number) =>
    reading(
      [],
      Array.from({ length: n }, (_, i) => ({ statement: `Finding ${i}`, categories: ['R69'] })),
    );
  assert.deepEqual((await run(many(41))).result, {
    outcome: 'failed',
    failureReason: FAILURES.tooMany,
  });
  assert.equal((await run(many(40))).result.outcome, 'success');
});

test('a visit after 2027-09-30 stops: "This flow has no code table for this visit date yet."', async () => {
  const { result } = await run({ ...ckd, visitDate: '2027-10-01' });
  assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.tooLate });
  const last = await run({ ...ckd, visitDate: '2027-09-30' }, { 'CKD stage 4': { code: 'N18.4' } });
  assert.equal(last.result.outcome === 'success' && last.result.output?.codeTable, '2027');
});

test("no visit date: the table for the day the run starts, said on the result; a date that isn't a day is none", async () => {
  for (const visitDate of [null, '2026-02-30']) {
    const { result } = await run(
      { ...ckd, visitDate },
      { 'CKD stage 4': { code: 'N18.4' } },
      { flow: { today: () => '2026-01-15' } },
    );
    assert.equal(result.outcome === 'success' && result.output?.codeTable, '2026');
    assert.equal(result.outcome === 'success' && result.title, WORDS.titlePlain);
    const texts = (result.outcome === 'success' ? (result.blocks ?? []) : []).filter(
      (b) => b.type === 'text',
    );
    assert.deepEqual(
      texts.map((b) => b.type === 'text' && b.text),
      [WORDS.noVisitDate, WORDS.footer('2026')],
    );
  }
});

test('each step reports under its id with its title, in order, and holds at decide', async () => {
  const { platform, result } = await run(
    reading(
      ['I10'],
      [
        { statement: 'Hypertension', categories: ['I10'] },
        { statement: 'CKD stage 3a', categories: ['N18'] },
      ],
    ),
    { Hypertension: { code: 'I10' }, 'CKD stage 3a': { code: 'N18.31' } },
  );
  assert.deepEqual(
    platform.steps.map((s) => [s.stepId, s.outcome, s.summary]),
    [
      ['receive', 'ok', 'Visit received'],
      ['read-note', 'ok', 'Note read'],
      ['check-note', 'ok', 'Note checked'],
      ['find-codes', 'ok', 'Code choices found'],
      ['match-codes', 'ok', 'Codes matched'],
      ['check-codes', 'ok', 'Codes checked'],
      ['decide', 'held', '2 codes · 2 to review'],
    ],
  );
  assert.equal(platform.steps.at(-1)?.heldReason, '2 changes need your review.');
  assert.equal(result.outcome === 'held' && result.held.stepId, 'decide');
});

test('nothing to decide: decide goes on, save runs, and the run succeeds with every code kept', async () => {
  const { platform, result } = await run(
    ckd,
    { 'CKD stage 4': { code: 'N18.4' } },
    { specialties: ['Cardiology'] },
  );
  assert.deepEqual(
    platform.steps.slice(-2).map((s) => [s.stepId, s.outcome]),
    [
      ['decide', 'ok'],
      ['save', 'ok'],
    ],
  );
  assert.equal(result.outcome === 'success' && result.summary, '1 codes · all supported');
  assert.deepEqual(rowsOf(result), [['N18.4', 'keep', null, 'G2']]);
});

test('read-note is sent the file whole and the specialties; match-codes no file', async () => {
  const { platform } = await run(
    ckd,
    { 'CKD stage 4': { code: 'N18.4' } },
    { specialties: ['Cardiology', 'Nephrology'] },
  );
  assert.equal(platform.modelCalls[0]?.artifactId, NOTE_ID);
  assert.deepEqual(platform.modelCalls[0]?.input, { specialties: 'Nephrology, Cardiology' });
  assert.equal(platform.modelCalls[1]?.artifactId, undefined);
  assert.deepEqual(
    platform.modelCalls.map((call) => call.models),
    [
      ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
      ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
    ],
  );
});

test('a note with no diagnosis to match sends nothing to match-codes', async () => {
  const { platform } = await run(reading(['I10'], []));
  assert.equal(platform.modelCalls.length, 1);
});
