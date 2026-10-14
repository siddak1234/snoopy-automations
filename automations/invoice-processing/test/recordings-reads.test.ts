import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { secondReadOf } from '../src/checks/answers.js';
import { VERIFY_DOCUMENT_V1 } from '../src/prompts.js';
import { compareReads, recheckedWith } from '../src/reads/compare.js';
import type { VerificationState } from '../src/state.js';
import { checkedSummary } from '../src/steps/check-document.js';
import { verifiedSummary } from '../src/steps/verify-read.js';
import { RUN_FAILS } from '../src/words.js';
import { check } from './check-world.js';
import { decide } from './decide-world.js';
import { QUICKBOOKS, everythingSaid, lines, reads, secondAnswer, setUp } from './fixtures.js';
import {
  FIRST_READ,
  READS,
  SECOND_READ,
  madeFor,
  readRecording,
  recordingFiles,
  recordingOf,
  recordingRequest,
  recordings,
} from './recordings.js';
import { SAMPLES } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * Each sample recorded twice — read 1 (`extract-document.v1`) and read 2 (`verify-document.v1`),
 * by separate agents blind to each other, each read in its own directory — and the recorded
 * answers run through check-document, verify-read's comparison and decide. The tests over
 * recordings run on whatever exist, and are skipped, saying why, while none do.
 */

const [typed] = SAMPLES;

test("two reads, two directories: read 2 recorded for verify-document v1, and neither loader takes the other's", () => {
  assert.ok(typed);
  assert.deepEqual(
    READS.map((read) => [read.name, read.prompt.id]),
    [
      ['read 1', 'extract-document'],
      ['read 2', 'verify-document'],
    ],
  );
  assert.notEqual(FIRST_READ.directory, SECOND_READ.directory);
  assert.match(SECOND_READ.directory, /test\/recordings\/verify-document\.v1$/u);
  const second = {
    ...madeFor(typed, SECOND_READ),
    recordedBy: 'an agent acting as the model, 2026-10-11',
    finishReason: 'stop',
    text: JSON.stringify(secondAnswer(typed.answer)),
  };
  assert.deepEqual(readRecording(second, madeFor(typed, SECOND_READ), 'typed'), second);
  assert.throws(
    () => readRecording(second, madeFor(typed, FIRST_READ), 'typed'),
    /another promptId/u,
  );
  const first = { ...second, ...madeFor(typed, FIRST_READ) };
  assert.throws(
    () => readRecording(first, madeFor(typed, SECOND_READ), 'typed'),
    /another promptId/u,
  );
  assert.throws(
    () =>
      readRecording(
        { ...second, promptSha256: madeFor(typed, FIRST_READ).promptSha256 },
        madeFor(typed, SECOND_READ),
        'typed',
      ),
    /another promptSha256/u,
  );
});

test("each read-2 request gives the agent what verify-read gives the model — and nothing of read 1's answer", () => {
  for (const sample of SAMPLES) {
    const request = recordingRequest(sample, SECOND_READ);
    assert.equal(request.systemInstruction, VERIFY_DOCUMENT_V1.template);
    assert.equal(request.userText, '{"task":"Extract the fields of the attached document."}');
    assert.deepEqual(request.responseSchema, VERIFY_DOCUMENT_V1.outputSchema);
    assert.equal(request.recording.promptId, 'verify-document');
    assert.match(request.saveAs, /test\/recordings\/verify-document\.v1\//u);
    assert.equal(request.file, recordingRequest(sample).file, 'the same file as read 1');
    assert.deepEqual(
      readRecording(request.recording, madeFor(sample, SECOND_READ), sample.name),
      request.recording,
    );
    const sent = JSON.stringify({ ...request, sample: '', file: '', saveAs: '' });
    for (const field of ['vendorName', 'documentNumber'] as const) {
      const value = sample.answer[field];
      if (typeof value === 'string') assert.ok(!sent.includes(value), `${sample.name}: ${field}`);
    }
  }
});

const firstFiles = recordingFiles(FIRST_READ);
const secondFiles = recordingFiles(SECOND_READ);
const where = (read: typeof FIRST_READ) => relative(process.cwd(), read.directory);

test(
  "every read-1 recording, run through check-document, takes its sample's route",
  {
    skip:
      firstFiles.length === 0
        ? `no recordings yet in ${where(FIRST_READ)}: scripts/recording-request.ts prints what each agent is given`
        : false,
  },
  (t) => {
    for (const { sample, recording } of recordings(FIRST_READ)) {
      const outcome = check(JSON.parse(recording.text));
      const [route, findings] = SAMPLE_ROUTES[sample.name]!;
      const got =
        outcome.outcome === 'failed'
          ? outcome.rule
          : (outcome.recordingRule ?? outcome.document.route);
      assert.equal(got, route, sample.name);
      if (outcome.outcome === 'ok') {
        assert.ok(!checkedSummary(outcome.document).includes(sample.marker), sample.name);
        const differ = outcome.document.findings.join() !== findings.join();
        if (differ)
          t.diagnostic(`${sample.name}: findings ${outcome.document.findings.join(', ')}`);
      }
    }
  },
);

test(
  "every read-2 recording is the schema, and is compared with the sample's expected answer as read 1",
  {
    skip:
      secondFiles.length === 0
        ? `no recordings yet in ${where(SECOND_READ)}: scripts/recording-request.ts --read 2 prints what each agent is given`
        : false,
  },
  (t) => {
    for (const { sample, recording } of recordings(SECOND_READ)) {
      const second = secondReadOf(JSON.parse(recording.text));
      assert.ok(second, `${sample.name}: the read-2 schema`);
      const first = check(sample.answer);
      if (first.outcome === 'failed') continue;
      const comparison = compareReads(first.document, second);
      const line = verifiedSummary({
        status: 'made',
        modelServed: 'a recording',
        ...comparison,
      });
      assert.ok(!JSON.stringify([comparison, line]).includes(sample.marker), sample.name);
      if (comparison.differences.length > 0) t.diagnostic(`${sample.name}: ${line}`);
    }
  },
);

test(
  "each sample recorded twice: read 2's recording compared with read 1's, as verify-read compares them",
  {
    skip:
      firstFiles.length === 0 || secondFiles.length === 0
        ? 'no sample has both recordings yet'
        : false,
  },
  (t) => {
    for (const sample of SAMPLES) {
      const [first, second] = [recordingOf(sample, FIRST_READ), recordingOf(sample, SECOND_READ)];
      if (!first || !second) continue;
      const outcome = check(JSON.parse(first.text) as JsonObject);
      const read = secondReadOf(JSON.parse(second.text));
      assert.ok(read, sample.name);
      if (outcome.outcome === 'failed') continue;
      const comparison = compareReads(outcome.document, read);
      assert.ok(!JSON.stringify(comparison).includes(sample.marker), sample.name);
      t.diagnostic(
        `${sample.name}: ${comparison.differences.length === 0 ? 'the reads agree' : comparison.differences.map((each) => each.field).join(', ')}`,
      );
    }
  },
);

test(
  "each sample's two recordings through the first steps and decide — the vendor matched, nothing found: no line, sentence, reason or saved data carries its marker",
  {
    skip:
      firstFiles.length === 0 || secondFiles.length === 0
        ? 'no sample has both recordings yet'
        : false,
  },
  async (t) => {
    let decided = 0;
    for (const sample of SAMPLES) {
      const [first, second] = [recordingOf(sample, FIRST_READ), recordingOf(sample, SECOND_READ)];
      if (!first || !second) continue;
      const answer = JSON.parse(first.text) as JsonObject;
      const secondText = JSON.parse(second.text) as JsonObject;
      // The run as far as it goes today, the model answering each read as it was recorded.
      const run = setUp({ config: QUICKBOOKS });
      run.platform.model = reads(answer, secondText);
      const result = await run.run();
      const said = everythingSaid(run.platform, result);
      assert.ok(!said.includes(sample.marker), `${sample.name}: the run's lines and result`);
      const checked = check(answer);
      if (checked.outcome === 'failed') {
        const { rule } = checked;
        assert.notEqual(rule, 'answer_unusable', sample.name);
        if (rule !== 'answer_unusable') {
          assert.deepEqual(
            result,
            { outcome: 'failed', failureReason: RUN_FAILS[rule] },
            sample.name,
          );
        }
        continue;
      }
      // Not recorded in QuickBooks: decide never runs, and the details are saved.
      if (checked.recordingRule !== undefined) continue;
      // decide, on what verify-read keeps: the comparison, and the arithmetic again on a total
      // the tie-break took from read 2.
      const read = secondReadOf(secondText);
      assert.ok(read, sample.name);
      const comparison = compareReads(checked.document, read);
      let document = checked.document;
      if (comparison.totalPicked === 'second' && comparison.secondTotalCents !== null) {
        const rechecked = recheckedWith(document, comparison.secondTotalCents);
        if (rechecked.rule !== undefined) continue;
        document = rechecked.document;
      }
      const verification: VerificationState = {
        status: 'made',
        modelServed: 'google/gemini-3.1-flash-lite',
        compared: comparison.compared,
        differences: comparison.differences,
        totalPicked: comparison.totalPicked,
        spendTypeDisputed: comparison.spendTypeDisputed,
      };
      for (const holdAboveAmount of [0, 1_000_000]) {
        const decision = decide({
          answer,
          verification,
          config: { holdAboveAmount },
          state: { document: document as unknown as JsonObject },
        });
        assert.ok(
          !JSON.stringify(decision).includes(sample.marker),
          `${sample.name}: decide (${decision.outcome})`,
        );
        if (holdAboveAmount > 0) t.diagnostic(`${sample.name}: ${decision.outcome}`);
        decided += 1;
      }
    }
    assert.equal(decided, 40, 'the 20 recordings check-document passes, each held and as it comes');
  },
);

test(
  "the card statement's recordings: both reads took its planted note for the document number, and the run fails C1 before anything carries it",
  {
    skip:
      firstFiles.includes('bank-card-statement.json') &&
      secondFiles.includes('bank-card-statement.json')
        ? false
        : 'the bank-card-statement sample has not both recordings yet',
  },
  async () => {
    const sample = SAMPLES.find((each) => each.name === 'bank-card-statement');
    assert.ok(sample);
    const [first, second] = [recordingOf(sample, FIRST_READ), recordingOf(sample, SECOND_READ)];
    const answers = [first, second].map((recording) => JSON.parse(recording?.text ?? '{}'));
    assert.deepEqual(
      answers.map((answer) => [answer.documentType, answer.documentNumber]),
      [
        ['bank_statement', sample.marker],
        ['bank_statement', sample.marker],
      ],
    );
    assert.deepEqual(check(answers[0]), { outcome: 'failed', rule: 'C1' });
    const run = setUp({ config: QUICKBOOKS });
    run.platform.model = reads(answers[0], answers[1]);
    const result = await run.run();
    assert.deepEqual(result, { outcome: 'failed', failureReason: RUN_FAILS.C1 });
    assert.deepEqual(lines(run.platform).at(-1), ['check-document', 'failed', RUN_FAILS.C1]);
    assert.equal(run.platform.modelCalls.length, 1, 'read 2 is not made for a document that fails');
    assert.ok(!everythingSaid(run.platform, result).includes(sample.marker));
  },
);

test('each recordings directory is kept in git by its placeholder, and holds one recording for every sample', () => {
  const samples = SAMPLES.map((sample) => `${sample.name}.json`).sort();
  for (const read of READS) {
    assert.equal(readFileSync(join(read.directory, '.gitkeep'), 'utf8'), '', read.name);
    assert.deepEqual(recordingFiles(read).sort(), samples, read.name);
  }
});
