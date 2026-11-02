import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  renderPrompt,
  type JsonObject,
  type ModelRequest,
  type RunResult,
} from '@autom8x/automation-sdk';

import { VERIFY_DOCUMENTS_V1 } from '../src/prompts.js';
import { compareReads } from '../src/reads/compare.js';
import { partAnswerOf, v2AnswerOf } from '../src/run/answer.js';
import { VERIFY_TASK, verifyAnswerOf } from '../src/run/verify.js';
import { check } from './check-world.js';
import {
  QUICKBOOKS,
  completion,
  isSecondRead,
  lines,
  reads,
  secondAnswer,
  setUp,
  verifyAnswer,
} from './fixtures.js';
import {
  FIRST_READ,
  READS,
  SECOND_READ,
  assertEverySampleRecorded,
  madeFor,
  readRecording,
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
 * run. Each test over the recordings first holds its read to one recording per sample: a missing
 * recording fails it, never skips it.
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

/** A read-1 recording's first document, as v2's checks read it. */
function firstDocument(text: string): JsonObject | undefined {
  const [document] = partAnswerOf(JSON.parse(text))?.documents ?? [];
  return document === undefined ? undefined : v2AnswerOf(document);
}

test("every read-1 recording's first document, run through the checks, takes its sample's route", (t) => {
  assertEverySampleRecorded(FIRST_READ);
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
});

test("every read-2 recording is the schema, and its first document is compared with the sample's expected answer as read 1", (t) => {
  assertEverySampleRecorded(SECOND_READ);
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
});

/**
 * The model as recorded: read 1's first part and read 2 as their recordings say, and any part of
 * read 1 after the first answered as done (nextDocument 0, nothing more listed) — a recording is
 * the first part alone, and answering it again would move the reading on without end. `later`
 * counts those parts; one asked after the done one is refused, so a reading that does not end
 * stops here.
 */
function asRecorded(first: JsonObject, second: JsonObject) {
  const recorded = reads(first, second);
  const double = {
    later: 0,
    model: (call: ModelRequest, model: string) => {
      if (isSecondRead(call) || (call.input.fromDocument === 1 && call.input.fromLine === 1)) {
        return recorded(call, model);
      }
      double.later += 1;
      if (double.later > 1) return Promise.reject(new Error('a part asked after the done one'));
      const done = {
        documentCount: first.documentCount,
        documents: [],
        nextDocument: 0,
        nextLine: 0,
      };
      return Promise.resolve(completion(model, done));
    },
  };
  return double;
}

test("each sample's two recordings through the whole run: no line, summary or reason carries its marker", async (t) => {
  for (const read of READS) assertEverySampleRecorded(read);
  // Only the 300-line sample's read 1 goes on past its recorded part; the double answers the
  // next part as done, so it runs through steps 1–8 like the others.
  const readsOn = (text: string) => partAnswerOf(JSON.parse(text))?.nextDocument !== null;
  assert.deepEqual(
    SAMPLES.filter((sample) => readsOn(recordingOf(sample, FIRST_READ)!.text)).map(
      (sample) => sample.name,
    ),
    ['long-300-lines'],
  );
  const ran: string[] = [];
  for (const sample of SAMPLES) {
    const [first, second] = [recordingOf(sample, FIRST_READ), recordingOf(sample, SECOND_READ)];
    assert.ok(first && second, sample.name);
    const run = setUp({ config: QUICKBOOKS, through: 'all' });
    const double = asRecorded(JSON.parse(first.text), JSON.parse(second.text));
    run.platform.model = double.model;
    const result: RunResult = await run.run();
    // The 300-line sample's reading asks one part more, answered as done, and ends there.
    assert.equal(double.later, readsOn(first.text) ? 1 : 0, `${sample.name}: the parts asked`);
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
    ran.push(sample.name);
  }
  assert.deepEqual(
    ran,
    SAMPLES.map((sample) => sample.name),
    'every sample ran whole',
  );
});

test('each recordings directory is kept in git by its placeholder, and holds recordings of samples alone', () => {
  for (const read of READS) {
    assert.equal(readFileSync(join(read.directory, '.gitkeep'), 'utf8'), '', read.name);
    // A file named after no sample is refused.
    assert.doesNotThrow(() => recordings(read), read.name);
  }
});

test('each read holds exactly one recording for every sample', () => {
  for (const read of READS) assertEverySampleRecorded(read);
});
