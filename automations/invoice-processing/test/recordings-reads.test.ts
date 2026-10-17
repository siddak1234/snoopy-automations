import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { renderPrompt, type JsonObject, type RunResult } from '@autom8x/automation-sdk';

import { VERIFY_DOCUMENTS_V1 } from '../src/prompts.js';
import { compareReads } from '../src/reads/compare.js';
import { partAnswerOf, v2AnswerOf } from '../src/run/answer.js';
import { VERIFY_TASK, verifyAnswerOf } from '../src/run/verify.js';
import { check } from './check-world.js';
import { QUICKBOOKS, lines, reads, secondAnswer, setUp, verifyAnswer } from './fixtures.js';
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
 * Each sample recorded twice — read 1 (`extract-documents.v1`, its first part) and read 2
 * (`verify-documents.v1`), by separate agents blind to each other, each read in its own directory
 * — and the recorded answers run through the checks, the second read's comparison and the whole
 * run. The tests over recordings run on whatever exist, and are skipped, saying why, while none do.
 */

const [typed] = SAMPLES;

test("two reads, two directories: read 2 recorded for verify-documents v1, and neither loader takes the other's", () => {
  assert.ok(typed);
  assert.deepEqual(
    READS.map((read) => [read.name, read.prompt.id]),
    [
      ['read 1', 'extract-documents'],
      ['read 2', 'verify-documents'],
    ],
  );
  assert.notEqual(FIRST_READ.directory, SECOND_READ.directory);
  assert.match(SECOND_READ.directory, /test\/recordings\/verify-documents\.v1$/u);
  const second = {
    ...madeFor(typed, SECOND_READ),
    recordedBy: 'an agent acting as the model, 2026-10-17',
    finishReason: 'stop',
    text: JSON.stringify(verifyAnswer([[1, secondAnswer(typed.answer)]], 1)),
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

test("each read-2 request gives the agent what verify-read gives the model — every document the sample holds, by place — and nothing of read 1's answer", () => {
  for (const sample of SAMPLES) {
    const request = recordingRequest(sample, SECOND_READ);
    const count = typeof sample.answer.documentCount === 'number' ? sample.answer.documentCount : 1;
    const positions = Array.from({ length: Math.max(1, count) }, (_, at) => at + 1).join(', ');
    const rendered = renderPrompt(VERIFY_DOCUMENTS_V1, { task: VERIFY_TASK, positions });
    assert.equal(request.systemInstruction, rendered.prompt, sample.name);
    assert.equal(request.userText, JSON.stringify(rendered.input));
    assert.deepEqual(request.responseSchema, VERIFY_DOCUMENTS_V1.outputSchema);
    assert.equal(request.recording.promptId, 'verify-documents');
    assert.match(request.saveAs, /test\/recordings\/verify-documents\.v1\//u);
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
const NOT_YET = (read: typeof FIRST_READ) =>
  `no recordings yet in ${where(read)}: scripts/recording-request.ts prints what each agent is given`;

/** A read-1 recording's first document, as v2's checks read it. */
function firstDocument(text: string): JsonObject | undefined {
  const [document] = partAnswerOf(JSON.parse(text))?.documents ?? [];
  return document === undefined ? undefined : v2AnswerOf(document);
}

test(
  "every read-1 recording's first document, run through the checks, takes its sample's route",
  { skip: firstFiles.length === 0 ? NOT_YET(FIRST_READ) : false },
  (t) => {
    for (const { sample, recording } of recordings(FIRST_READ)) {
      const answer = firstDocument(recording.text);
      assert.ok(answer, `${sample.name}: the schema`);
      const [route] = SAMPLE_ROUTES[sample.name]!;
      if (route === 'kept') {
        assert.equal(answer.documentType, 'bank_statement', sample.name);
        continue;
      }
      const outcome = check(answer);
      const got =
        outcome.outcome === 'failed'
          ? outcome.rule
          : (outcome.recordingRule ?? outcome.document.route);
      if (got !== route) t.diagnostic(`${sample.name}: ${got}, not ${route}`);
      assert.equal(got, route, sample.name);
    }
  },
);

test(
  "every read-2 recording is the schema, and its first document is compared with the sample's expected answer as read 1",
  { skip: secondFiles.length === 0 ? NOT_YET(SECOND_READ) : false },
  (t) => {
    for (const { sample, recording } of recordings(SECOND_READ)) {
      const answer = verifyAnswerOf(JSON.parse(recording.text));
      const second = answer?.documents.get(1);
      assert.ok(second, `${sample.name}: the read-2 schema`);
      const first = check(sample.answer);
      if (first.outcome === 'failed') continue;
      const comparison = compareReads(first.document, second);
      assert.ok(!JSON.stringify(comparison).includes(sample.marker), sample.name);
      if (comparison.differences.length > 0) {
        t.diagnostic(
          `${sample.name}: ${comparison.differences.map((each) => each.field).join(', ')}`,
        );
      }
    }
  },
);

test(
  "each sample's two recordings through the whole run: no line, summary or reason carries its marker",
  {
    skip:
      firstFiles.length === 0 || secondFiles.length === 0
        ? 'no sample has both recordings yet'
        : false,
  },
  async (t) => {
    for (const sample of SAMPLES) {
      const [first, second] = [recordingOf(sample, FIRST_READ), recordingOf(sample, SECOND_READ)];
      if (!first || !second) continue;
      const run = setUp({ config: QUICKBOOKS, through: 'all' });
      run.platform.model = reads(JSON.parse(first.text), JSON.parse(second.text));
      const result: RunResult = await run.run();
      // What a person reads: each line, and the summary, the approval's reason or the failure.
      const ending =
        result.outcome === 'success'
          ? result.summary
          : result.outcome === 'held'
            ? result.held.reason
            : result.failureReason;
      const said = JSON.stringify([lines(run.platform), ending]);
      assert.ok(!said.includes(sample.marker), `${sample.name}: the run's lines and summary`);
      t.diagnostic(`${sample.name}: ${ending ?? result.outcome}`);
    }
  },
);

test('each recordings directory is kept in git by its placeholder, and holds recordings of samples alone', () => {
  for (const read of READS) {
    assert.equal(readFileSync(join(read.directory, '.gitkeep'), 'utf8'), '', read.name);
    // A file named after no sample is refused.
    assert.doesNotThrow(() => recordings(read), read.name);
  }
});

test(
  'once recorded, each read holds one recording for every sample',
  {
    skip:
      firstFiles.length === 0 && secondFiles.length === 0
        ? "v3's recordings are still to be made"
        : false,
  },
  () => {
    const samples = SAMPLES.map((sample) => `${sample.name}.json`).sort();
    for (const read of READS) assert.deepEqual(recordingFiles(read).sort(), samples, read.name);
  },
);
