import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FLOW_WORDS } from '@autom8x/automation-sdk';

import { FAILURES, WORDS } from '../src/words.js';
import { asksOf, platformFor, reading, rowsOf, run } from './fixtures.js';

/**
 * The spec's section 9, rows 1 to 14, one test each, on made-up notes (`automations/icd10-code-check/test/spec-2.test.ts` the
 * rest). Each runs the whole flow on `RecordingPlatform`: `receive`, `read-note`, `check-note`,
 * `find-codes`, `match-codes`, `check-codes`, `decide`, and `save` once a review is answered.
 */

test('§9 N18.4 and N18.6, "ESRD, previously stage 4.": N18.4 Remove (K1), N18.6 Keep, held', async () => {
  const note = reading(
    ['N18.4', 'N18.6'],
    [{ statement: 'ESRD, previously stage 4.', categories: ['N18'] }],
  );
  const { result } = await run(note, {
    'ESRD, previously stage 4.': { code: 'N18.6', quote: 'ESRD' },
  });
  assert.equal(result.outcome, 'held');
  assert.deepEqual(rowsOf(result).slice(0, 2), [
    ['N18.4', 'remove', null, 'K1'],
    ['N18.6', 'keep', null, 'G2'],
  ]);
});

test('§9 I50.9, "Suspected heart failure, rule out. Short of breath on exertion.": Change to R06.02 (G4), held', async () => {
  const note = reading(
    ['I50.9'],
    [
      {
        statement: 'Suspected heart failure, rule out.',
        categories: ['I50'],
        certainty: 'uncertain',
      },
      { statement: 'Short of breath on exertion.', categories: ['R06'] },
    ],
  );
  const { result } = await run(note, {
    'Suspected heart failure': { code: 'I50.9', quote: 'heart failure' },
    'Short of breath': { code: 'R06.02', quote: 'Short of breath' },
  });
  assert.equal(result.outcome, 'held');
  assert.deepEqual(rowsOf(result), [['I50.9', 'change', 'R06.02', 'G4']]);
});

test('§9 N18.31, "CKD stage 3a, with acute kidney injury today.": N18.31 Keep, Add the AKI code (G7), held', async () => {
  const note = reading(
    ['N18.31'],
    [
      { statement: 'CKD stage 3a', categories: ['N18'] },
      { statement: 'with acute kidney injury today.', categories: ['N17'] },
    ],
  );
  const { result } = await run(note, {
    'CKD stage 3a': { code: 'N18.31' },
    'acute kidney injury': { code: 'N17.9', quote: 'acute kidney injury' },
  });
  assert.equal(result.outcome, 'held');
  assert.deepEqual(rowsOf(result), [
    ['N18.31', 'keep', null, 'G2'],
    ['N17.9', 'add', 'N17.9', 'G7'],
  ]);
});

test('§9 a blank PDF: stops, "The note could not be read. Try a clearer PDF or photo."', async () => {
  const blank = { ...reading([], []), isVisitNote: false, readable: false, patientCount: 0 };
  const { result, platform } = await run(blank);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.unreadable });
  assert.equal(platform.modelCalls.length, 1, 'nothing sent to match-codes');
});

test('§9 I10, "Hypertension and CKD stage 3a.": I10 Change to I12.9 (L1), Add N18.31 after it, held', async () => {
  const note = reading(
    ['I10'],
    [
      { statement: 'Hypertension', categories: ['I10'] },
      { statement: 'CKD stage 3a', categories: ['N18'] },
    ],
  );
  const ran = await run(note, {
    Hypertension: { code: 'I10' },
    'CKD stage 3a': { code: 'N18.31' },
  });
  assert.equal(ran.result.outcome, 'held');
  assert.deepEqual(rowsOf(ran.result), [
    ['I10', 'change', 'I12.9', 'L1'],
    ['N18.31', 'add', 'N18.31', 'G7'],
  ]);
});

test('§9 I12.9 with neither condition in the note: Ask (G6), no code in its place', async () => {
  const note = reading(
    ['I12.9'],
    [{ statement: 'Seasonal allergies', categories: ['J30'], thisVisit: false }],
  );
  const { result } = await run(note, { 'Seasonal allergies': { code: 'J30.2' } });
  assert.deepEqual(rowsOf(result), [['I12.9', 'ask', null, 'G6']]);
  assert.equal(result.outcome, 'success', 'an ask is shown, never decided');
  assert.deepEqual(
    result.outcome === 'success' && result.output?.finalCodes,
    ['I12.9'],
    "the note's code stays",
  );
});

test('§9 every ask and every block string of every case: no "payment", "reimbursement" or "pay"', async () => {
  const cases = [
    reading(['N18.4', 'N18.6'], [{ statement: 'ESRD, previously stage 4.', categories: ['N18'] }]),
    reading(['N18.6'], [{ statement: 'ESRD.', categories: ['N18'] }]),
    reading(['N18.9'], [{ statement: 'CKD', categories: ['N18'] }]),
    reading(
      ['E11.22', 'N18.4', 'I10'],
      [{ statement: 'Diabetes with CKD stage 4', categories: ['E11', 'N18'] }],
    ),
    reading(['I12.9'], []),
  ];
  for (const note of cases) {
    for (const specialties of [
      ['Nephrology'],
      ['Cardiology', 'Endocrinology', 'Internal medicine'],
    ]) {
      const { result } = await run(
        note,
        { ESRD: { code: 'N18.6' }, CKD: { code: 'N18.9' }, Diabetes: { code: 'E11.22' } },
        { specialties },
      );
      assert.doesNotMatch(
        JSON.stringify(
          result.outcome === 'held' ? { blocks: result.blocks, asks: asksOf(result) } : result,
        ),
        /\b(pay|payment|reimbursement)\b/iu,
      );
    }
  }
});

test('§9 N18.32 and I10, "CKD stage 3b. Hypertension.": I10 Change to I12.9, before N18.32 (L1, L3)', async () => {
  const note = reading(
    ['N18.32', 'I10'],
    [
      { statement: 'CKD stage 3b.', categories: ['N18'] },
      { statement: 'Hypertension.', categories: ['I10'] },
    ],
  );
  const ran = await run(note, {
    'CKD stage 3b': { code: 'N18.32' },
    Hypertension: { code: 'I10' },
  });
  assert.deepEqual(rowsOf(ran.result), [
    ['N18.32', 'keep', null, 'G2'],
    ['I10', 'change', 'I12.9', 'L1, L3'],
  ]);
  const { review } = await import('./fixtures.js');
  const done = await review(ran, { n2: 'accepted' });
  assert.deepEqual(done.result.outcome === 'success' && done.result.output?.finalCodes, [
    'I12.9',
    'N18.32',
  ]);
});

test('§9 match-codes quotes words that are not in the statement: the match is withdrawn, the diagnosis is an ask', async () => {
  const note = reading([], [{ statement: 'CKD stage 4', categories: ['N18'] }]);
  const { result } = await run(note, {
    'CKD stage 4': { code: 'N18.4', quote: 'stage 5 kidney failure' },
  });
  assert.notEqual(result.outcome, 'held', 'nothing it named is offered');
  assert.deepEqual(rowsOf(result), []);
  const blocks = JSON.stringify(result.outcome === 'success' ? result.blocks : []);
  assert.match(blocks, /“CKD stage 4”/u);
  assert.doesNotMatch(blocks, /N18\.4/u);
});

test("§9 read-note's answer cut off at the token limit: the step fails in the SDK's words, never a result", async () => {
  const platform = platformFor(reading([], []));
  platform.model = (_call, model) =>
    Promise.resolve({
      text: '{"isVisitNote": tr',
      model,
      finishReason: 'length',
      usage: { inputTokens: 1, outputTokens: 8000, totalTokens: 8001 },
    });
  const { result } = await run(reading([], []), {}, { platform });
  assert.deepEqual(result, { outcome: 'failed', failureReason: FLOW_WORDS.ai_too_long });
});

test('§9 visit 2025-11-12 with a code valid only in the 2027 table: the 2026 table only, Change or Ask (G1), no 2027 code offered', async () => {
  const note = reading(['I42.00'], [{ statement: 'Dilated cardiomyopathy', categories: ['I42'] }], {
    visitDate: '2025-11-12',
  });
  const { result, platform } = await run(
    note,
    { 'Dilated cardiomyopathy': { code: 'I42.0' } },
    { specialties: ['Cardiology'] },
  );
  assert.deepEqual(rowsOf(result), [['I42.00', 'change', 'I42.0', 'G1']]);
  const sent = JSON.stringify(platform.modelCalls[1]?.input);
  assert.match(sent, /"I42\.0"/u);
  assert.doesNotMatch(sent, /I42\.00|I42\.01|I42\.09/u, 'no code of the 2027 table is offered');
  assert.match(JSON.stringify(result), /I42\.00 is not a complete 2026 code\./u);
});

test('§9 visit 2026-10-20: the 2027 table only', async () => {
  const note = reading(['I42.00'], [{ statement: 'Dilated cardiomyopathy', categories: ['I42'] }], {
    visitDate: '2026-10-20',
  });
  const { result, platform } = await run(
    note,
    { 'Dilated cardiomyopathy': { code: 'I42.00' } },
    { specialties: ['Cardiology'] },
  );
  assert.deepEqual(rowsOf(result), [['I42.00', 'keep', null, 'G2']]);
  const sent = JSON.stringify(platform.modelCalls[1]?.input);
  assert.match(sent, /"I42\.00"/u);
  assert.doesNotMatch(sent, /"I42\.0"/u, 'the 2026 header is not offered');
  assert.equal(result.outcome === 'success' && result.output?.codeTable, '2027');
});

test('§9 visit 2026-05-02 with the April 2026 table unconfirmed: held at check-note', async () => {
  const note = reading(['N18.4'], [{ statement: 'CKD stage 4', categories: ['N18'] }], {
    visitDate: '2026-05-02',
  });
  const { result, platform } = await run(note, {}, { flow: { tables: ['2026-oct', '2027-oct'] } });
  assert.equal(result.outcome === 'held' && result.held.stepId, 'check-note');
  assert.equal(platform.steps.at(-1)?.heldReason, WORDS.aprilHold);
  const confirmed = await run(note, { 'CKD stage 4': { code: 'N18.4' } });
  assert.equal(
    confirmed.result.outcome === 'success' && confirmed.result.output?.codeTable,
    'April 2026',
  );
});

test('§9 visit 2025-09-15: stops, "This visit is before Oct 1, 2025. …"', async () => {
  const note = reading(['N18.4'], [{ statement: 'CKD stage 4', categories: ['N18'] }], {
    visitDate: '2025-09-15',
  });
  const { result } = await run(note);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.tooEarly });
});
