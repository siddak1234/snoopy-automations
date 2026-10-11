import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  idempotencyKeyFor,
  loadPrompts,
  renderPrompt,
  type InvokeRequest,
  type JsonObject,
} from '@autom8x/automation-sdk';
import { NO_ANSWER } from '@autom8x/automation-sdk/testing';

import { EXTRACT_INVOICE_V1 } from '../src/prompts.js';
import { EXTRACT_INPUT, MODELS } from '../src/steps/extract.js';
import { SEEDED_STATE, extractWorld } from './extract-world.js';
import { FILE_ID, GOOD_ANSWER, completion, lines, setUp } from './fixtures.js';

/**
 * `extract` when an answer comes: the one request it sends, the prompt file it sends, the
 * platform's fallback to the second model, answers kept whole whatever they say, the time
 * guard, and a continuation, which never calls the model.
 */

const PROMPTS = resolve(import.meta.dirname, '..', 'prompts');

/** The 18 decided fields, in the schema's order. */
const FIELDS = [
  'documentType',
  'invoiceCount',
  'pagesMissing',
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'paymentTermsDays',
  'currency',
  'subtotal',
  'tax',
  'shipping',
  'discount',
  'total',
  'amountDue',
  'lineItems',
  'lineItemsComplete',
  'uncertainFields',
];

function extractLine(world: ReturnType<typeof setUp>) {
  return lines(world.platform).find(([stepId]) => stepId === 'extract');
}

test("it sends one model request: the registered extract-invoice v1, the fixed task, MODELS and the run's file, nothing else", async () => {
  const world = setUp();
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(world.platform.modelCalls, [
    {
      capability: 'document-extraction',
      prompt: EXTRACT_INVOICE_V1.template,
      input: { task: 'Extract the fields of the attached supplier invoice.' },
      outputSchema: EXTRACT_INVOICE_V1.outputSchema,
      models: ['anthropic/claude-haiku-4.5', 'google/gemini-3.1-flash-lite'],
      artifactId: FILE_ID,
    },
  ]);
  // The template is sent as it is: it has no placeholder, so no input can change it.
  assert.equal(renderPrompt(EXTRACT_INVOICE_V1, EXTRACT_INPUT).prompt, EXTRACT_INVOICE_V1.template);
});

test('it makes no provider call and sends no mail', async () => {
  const world = setUp();
  await world.run();
  const key = idempotencyKeyFor(world.request.runId, 'extract');
  assert.deepEqual(
    world.platform.providerCalls.filter((call) => call.idempotencyKey === key),
    [],
  );
  assert.equal(world.platform.providerCalls.length, 3, "the three reads' calls and no other");
  assert.deepEqual(world.platform.mails, []);
});

test("the prompt file loads, passes the platform's keyword check, names no model, has no placeholder, and holds the 18 decided fields", () => {
  // `loadPrompts` holds each file to `definePrompt`: the platform's keyword set, no model.
  const [loaded, ...others] = loadPrompts(PROMPTS);
  assert.deepEqual(others, [], 'one prompt file');
  assert.deepEqual(loaded, EXTRACT_INVOICE_V1);
  assert.deepEqual(
    [loaded?.id, loaded?.version, loaded?.capability],
    ['extract-invoice', 1, 'document-extraction'],
  );
  const raw = JSON.parse(readFileSync(join(PROMPTS, 'extract-invoice.v1.json'), 'utf8')) as object;
  assert.deepEqual(Object.keys(raw), ['id', 'version', 'capability', 'template', 'outputSchema']);
  const template = loaded?.template ?? '';
  assert.ok(!template.includes('{{'), 'no placeholder: nothing typed reaches the prompt');
  assert.deepEqual(
    template
      .split('\n')
      .filter((line) => /^\d+\. /u.test(line))
      .map((line) => Number.parseInt(line, 10)),
    Array.from({ length: 13 }, (_, index) => index + 1),
    'the 13 rules, in order',
  );
  const schema = loaded?.outputSchema as {
    properties: Record<string, { items?: { additionalProperties?: unknown; enum?: unknown } }>;
    required: string[];
    additionalProperties: unknown;
  };
  assert.deepEqual(Object.keys(schema.properties), FIELDS);
  assert.deepEqual(schema.required, FIELDS, 'every field required');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.lineItems?.items?.additionalProperties, false);
  assert.deepEqual(schema.properties.uncertainFields?.items?.enum, FIELDS.slice(0, 16));
});

test('the line names the model that served and two counts; the state keeps the answer whole, every earlier key, and the model', async () => {
  const world = extractWorld();
  const answer = {
    ...GOOD_ANSWER,
    lineItems: [{ description: 'One line', amount: 1 }],
    lineItemsComplete: false,
    uncertainFields: ['invoiceDate', 'total'],
  };
  // The router may serve a dated id: it is kept as served.
  world.platform.model = (_call, model) => Promise.resolve(completion(`${model}-20261001`, answer));
  assert.deepEqual(await world.state(), {
    ...SEEDED_STATE,
    extraction: answer,
    modelServed: 'anthropic/claude-haiku-4.5-20261001',
  });
  assert.deepEqual(
    world.platform.steps.at(-1)?.summary,
    'Read the invoice with anthropic/claude-haiku-4.5-20261001: 1 line (more on the invoice), 2 unclear',
  );
  // A served id however long leaves the counts in the line.
  const long = extractWorld();
  long.platform.model = (_call) => Promise.resolve(completion(`vendor/${'m'.repeat(150)}`, answer));
  await long.state();
  assert.match(
    long.platform.steps.at(-1)?.summary ?? '',
    /: 1 line \(more on the invoice\), 2 unclear$/u,
  );
  const full = setUp();
  const result = await full.run();
  assert.ok(
    result.outcome === 'success' && !('extraction' in (result.output ?? {})),
    'never an output',
  );
});

test('fallback: the first model answers off the schema, the second reads it, and the line names the second', async () => {
  const world = setUp();
  world.platform.model = (_call, model) =>
    Promise.resolve(
      model === MODELS[0]
        ? completion(model, { ...GOOD_ANSWER, total: 'twelve' })
        : completion(model),
    );
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(world.platform.modelAttempts, [
    { model: 'anthropic/claude-haiku-4.5', outcome: 'refused' },
    { model: 'google/gemini-3.1-flash-lite', outcome: 'ok' },
  ]);
  assert.deepEqual(extractLine(world), [
    'extract',
    'ok',
    'Read the invoice with google/gemini-3.1-flash-lite: 2 lines, 0 unclear',
  ]);
});

test('fallback: the first model gets no answer in time, and the second reads it', async () => {
  const world = setUp();
  world.platform.model = (_call, model) =>
    Promise.resolve(model === MODELS[0] ? NO_ANSWER : completion(model));
  assert.equal((await world.run()).outcome, 'success');
  assert.deepEqual(
    world.platform.modelAttempts.map((attempt) => attempt.outcome),
    ['unanswered', 'ok'],
  );
});

test("an answer finishing 'other' is read as one finishing 'stop'", async () => {
  const world = extractWorld();
  world.platform.model = (_call, model) => Promise.resolve(completion(model, GOOD_ANSWER, 'other'));
  assert.deepEqual((await world.state())?.extraction, GOOD_ANSWER);
});

test('schema-valid wrong answers pass unchanged, for the next step to judge', async () => {
  const nothing = Object.fromEntries(FIELDS.map((field) => [field, null]));
  const wrong: Record<string, JsonObject> = {
    'all null': {
      ...nothing,
      documentType: 'invoice',
      invoiceCount: 1,
      pagesMissing: false,
      lineItems: [],
      lineItemsComplete: true,
      uncertainFields: [],
    },
    'wrong sums': { ...GOOD_ANSWER, subtotal: 999.99, total: 5 },
    'an invented vendor': { ...GOOD_ANSWER, vendorName: 'Nobody Printed This Inc' },
    'obeying injected text': { ...GOOD_ANSWER, vendorName: 'Trusted Vendor Inc', total: 1 },
    '41 lines marked complete': {
      ...GOOD_ANSWER,
      lineItems: Array.from({ length: 41 }, (_, index) => ({
        description: `Item ${index + 1}`,
        amount: 1,
      })),
      lineItemsComplete: true,
    },
  };
  for (const [name, answer] of Object.entries(wrong)) {
    const world = extractWorld();
    world.platform.model = (_call, model) => Promise.resolve(completion(model, answer));
    assert.deepEqual((await world.state())?.extraction, answer, name);
    assert.equal(world.platform.modelCalls.length, 1, `${name}: no second paid call`);
  }
});

test('the time guard: with less than 260 s to the deadline no model call is bought', async () => {
  const late = setUp({ deadlineInMs: 200_000 });
  assert.deepEqual(await late.run(), {
    outcome: 'failed',
    failureReason:
      'The run ran out of time before the invoice was read; start it again with the invoice.',
  });
  assert.deepEqual(extractLine(late), [
    'extract',
    'failed',
    'The invoice could not be read (out_of_time)',
  ]);
  assert.deepEqual(late.platform.modelCalls, []);
  const inTime = setUp({ deadlineInMs: 300_000 });
  assert.equal((await inTime.run()).outcome, 'success');
});

function continuing(request: InvokeRequest, stepId: string, state: JsonObject): InvokeRequest {
  return {
    ...request,
    continuation: {
      ofRunId: '66666666-6666-4666-8666-666666666666',
      kind: 'approval',
      stepId,
      decision: 'approved',
      decidedAt: new Date().toISOString(),
      state,
    },
  };
}

test('a continuation after approval never calls the model', async () => {
  // An approval resumes after the step that held, and every step that can hold comes after
  // this one: here, after the last step of the pipeline as it stands.
  const world = setUp();
  const state = { ...SEEDED_STATE, extraction: GOOD_ANSWER, modelServed: MODELS[0] };
  const result = await world.automation.execute(
    continuing(world.request, 'extract', state),
    world.platform,
  );
  assert.equal(result.outcome, 'success');
  assert.deepEqual(world.platform.modelCalls, []);
  assert.deepEqual(world.platform.steps, []);
});

test('a state without the upload ends with the fault-on-our-side sentence, and no model call', async () => {
  for (const file of [undefined, {}, { artifactId: 'invoice.pdf' }, { artifactId: 42 }]) {
    const world = setUp();
    const { file: _kept, ...rest } = SEEDED_STATE;
    const state = file === undefined ? rest : { ...rest, file };
    const result = await world.automation.execute(
      continuing(world.request, 'find-account', state),
      world.platform,
    );
    assert.deepEqual(
      result,
      {
        outcome: 'failed',
        failureReason:
          'The invoice could not be sent to be read because of a fault on our side; nothing was created.',
      },
      JSON.stringify(file),
    );
    assert.deepEqual(world.platform.modelCalls, []);
  }
});
