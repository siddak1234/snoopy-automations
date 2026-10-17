import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { renderPrompt, type JsonObject } from '@autom8x/automation-sdk';

import { EXTRACT_DOCUMENTS_V1 } from '../src/prompts.js';
import { partAnswerOf } from '../src/run/answer.js';
import { partInput } from '../src/run/extract.js';
import { runStateOf } from '../src/run/state.js';
import { extractWorld } from './extract-world.js';
import { completion } from './fixtures.js';
import {
  FIRST_READ,
  RECORDINGS_DIRECTORY,
  madeFor,
  readRecording,
  recordingFiles,
  recordingOf,
  recordingRequest,
  recordings,
} from './recordings.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The recordings — answers made by agents acting as the model, one per sample, verbatim — and
 * the loader that refuses one made for another prompt or another file. The tests over the
 * recordings run on whatever recordings exist, and are skipped, saying why, while none do.
 */

const [typed, scanned] = SAMPLES;

test('the loader takes a recording made for this prompt file and this sample, and refuses one made for anything else', () => {
  assert.ok(typed && scanned);
  const made = madeFor(typed);
  const good = {
    ...made,
    recordedBy: 'an agent acting as the model, 2026-10-11',
    finishReason: 'stop',
    text: JSON.stringify(typed.answer),
  };
  assert.deepEqual(readRecording(good, made, 'typed'), good);
  const refusals: [JsonObject, RegExp][] = [
    [{ promptId: 'extract-fields' }, /another promptId/u],
    [{ promptVersion: 2 }, /another promptVersion/u],
    [{ promptSha256: '0'.repeat(64) }, /another promptSha256/u],
    [{ fileSha256: madeFor(scanned).fileSha256 }, /another fileSha256/u],
    [{ finishReason: 'eos' }, /no finish reason/u],
    [{ text: typed.answer }, /answer as text/u],
    [{ recordedBy: ' ' }, /who recorded/u],
    [{ reviewed: true }, /must have exactly/u],
  ];
  for (const [change, words] of refusals) {
    assert.throws(() => readRecording({ ...good, ...change }, made, 'typed'), words);
  }
  const { text: _text, ...withoutText } = good;
  assert.throws(() => readRecording(withoutText, made, 'typed'), /must have exactly/u);
  assert.throws(() => readRecording([good], made, 'typed'), /is not a recording/u);
  // What a refusal says names the field, never the answer.
  assert.throws(
    () => readRecording({ ...good, fileSha256: 'x' }, made, 'typed'),
    (error: unknown) => error instanceof Error && !error.message.includes(typed.marker),
  );
});

test('each request gives the agent what the platform gives the model — the first part, its numbers in the instruction — and a recording the loader takes', () => {
  const repository = resolve(import.meta.dirname, '..', '..', '..');
  const rendered = renderPrompt(EXTRACT_DOCUMENTS_V1, partInput({ document: 1, line: 1 }, 0));
  for (const sample of SAMPLES) {
    const request = recordingRequest(sample);
    assert.equal(request.systemInstruction, rendered.prompt);
    assert.ok(request.systemInstruction.includes('Start at document 1, and with its line 1.'));
    assert.equal(request.userText, JSON.stringify(rendered.input));
    assert.ok(request.userText.includes('Extract the documents in the attached file.'));
    assert.deepEqual(request.responseSchema, EXTRACT_DOCUMENTS_V1.outputSchema);
    assert.equal(request.recording.promptId, 'extract-documents');
    assert.match(request.saveAs, /test\/recordings\/extract-documents\.v1\//u);
    assert.equal(
      request.file,
      `automations/invoice-processing/test/samples/${sample.name}/${sample.file}`,
    );
    assert.equal(readFileSync(join(repository, request.file)).length, request.sizeBytes);
    assert.equal(
      join(repository, request.saveAs),
      join(RECORDINGS_DIRECTORY, `${sample.name}.json`),
    );
    assert.deepEqual(
      readRecording(request.recording, madeFor(sample), sample.name),
      request.recording,
    );
  }
});

// Read for their names only: a recording that is refused fails the test that reads it.
const files = recordingFiles();
const where = relative(process.cwd(), RECORDINGS_DIRECTORY);

test(
  'every recording is one part extract takes: held to the schema, each document kept in the state, the model that served named, the marker in no line',
  {
    skip:
      files.length === 0
        ? `no recordings yet in ${where}: scripts/recording-request.ts prints what each agent is given`
        : false,
  },
  async (t) => {
    for (const { sample, recording } of recordings()) {
      const part = partAnswerOf(JSON.parse(recording.text));
      assert.ok(part, `${sample.name}: the schema`);
      // A recording is read 1's first part alone: a run that reads on is not recorded.
      if (part.nextDocument !== null) {
        t.diagnostic(`${sample.name}: the reading goes on at document ${part.nextDocument}`);
        continue;
      }
      const world = extractWorld();
      world.platform.model = (_call, model) =>
        Promise.resolve(completion(model, recording.text, recording.finishReason));
      const state = (await world.state()) ?? {};
      assert.equal(state.modelServed, 'anthropic/claude-haiku-4.5', sample.name);
      assert.equal(runStateOf(state)?.documents.length, part.documents.length, sample.name);
      const said = JSON.stringify(world.platform.steps);
      assert.ok(!said.includes(sample.marker), `${sample.name}: the marker reached the line`);
      // For the person who reviews it: where the recording and expected.json part.
      const [first] = (JSON.parse(recording.text) as { documents: JsonObject[] }).documents;
      const differ = Object.keys(sample.answer).filter(
        (field) =>
          first !== undefined &&
          field in first &&
          !isDeepStrictEqual(first[field], sample.answer[field]),
      );
      if (differ.length > 0)
        t.diagnostic(`${sample.name} differs from expected.json on ${differ.join(', ')}`);
    }
  },
);

test(
  "the 300-line sample's recording lists at most the part's 80 lines, says where the next part starts, and stays under 24,000 characters",
  {
    skip: files.includes('long-300-lines.json')
      ? false
      : `no recording of long-300-lines yet in ${where}`,
  },
  () => {
    const sample = SAMPLES.find((each) => each.name === 'long-300-lines');
    const recording = sample ? recordingOf(sample, FIRST_READ) : undefined;
    const part = partAnswerOf(JSON.parse(recording?.text ?? '{}'));
    assert.ok(part);
    const lines = part.documents.reduce((sum, document) => sum + document.lineItems.length, 0);
    assert.ok(lines <= 80, String(lines));
    assert.deepEqual([part.nextDocument, part.nextLine], [1, lines + 1]);
    assert.ok((recording?.text.length ?? 0) < 24_000);
  },
);
