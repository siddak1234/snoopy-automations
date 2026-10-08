import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { definePrompt, loadPrompts, readJsonCompletion, renderPrompt } from '../src/prompt.js';

/**
 * Prompt modules: versioned, by capability, never by model; rendered from the
 * run's input; loaded from files whose errors never quote their content.
 */

const module = {
  id: 'extract-invoice',
  version: 2,
  capability: 'document-extraction' as const,
  template: 'Extract {{ fields }} from the {{kind}} below. Amount is in {{currency}}.',
  outputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
};

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

test('a prompt is validated and frozen, and one that names a model is refused', () => {
  const prompt = definePrompt(module);
  assert.ok(Object.isFrozen(prompt));
  assert.deepEqual(prompt, module);

  assert.throws(
    () => definePrompt({ ...module, model: 'gemini-2.5-flash' } as never),
    /prompt extract-invoice names a model; the platform chooses what it spends/u,
  );
  assert.throws(() => definePrompt({ ...module, id: 'Extract Invoice' }), /must be lowercase/u);
  assert.throws(() => definePrompt({ ...module, version: 0 }), /positive integer version/u);
  assert.throws(() => definePrompt({ ...module, version: 1.5 }), /positive integer version/u);
  assert.throws(
    () => definePrompt({ ...module, capability: 'mind-reading' as never }),
    /names no capability the platform offers/u,
  );
  assert.throws(() => definePrompt({ ...module, template: '   ' }), /empty template/u);
  assert.throws(
    () => definePrompt({ ...module, outputSchema: 'object' as never }),
    /must carry an outputSchema object/u,
  );
});

test('a template is rendered from the input, and a field the input lacks is named without its value', () => {
  const request = renderPrompt(definePrompt(module), {
    fields: 'vendor, amount, reference',
    kind: 'invoice',
    currency: 'USD',
    text: 'the document itself',
  });
  assert.deepEqual(request, {
    capability: 'document-extraction',
    prompt: 'Extract vendor, amount, reference from the invoice below. Amount is in USD.',
    input: {
      fields: 'vendor, amount, reference',
      kind: 'invoice',
      currency: 'USD',
      text: 'the document itself',
    },
    outputSchema: module.outputSchema,
  });
  assert.deepEqual(Object.keys(request).sort(), ['capability', 'input', 'outputSchema', 'prompt']);

  assert.throws(
    () =>
      renderPrompt(definePrompt(module), {
        fields: 'x',
        kind: 'invoice',
        currency: { iso: 'USD' },
      }),
    (error: unknown) =>
      error instanceof Error &&
      /prompt extract-invoice v2 names \{\{currency\}\}, which the input does not carry as text/u.test(
        error.message,
      ) &&
      !error.message.includes('USD'),
  );
});

test('prompts load from a directory by filename, and a bad file is named, never quoted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'prompts-'));
  directories.push(directory);
  writeFileSync(
    join(directory, 'b-summarise.v1.json'),
    JSON.stringify({ ...module, id: 'summarise', version: 1 }),
  );
  writeFileSync(join(directory, 'a-extract.v2.json'), JSON.stringify(module));
  writeFileSync(join(directory, 'notes.txt'), 'not a prompt');
  assert.deepEqual(
    loadPrompts(directory).map((prompt) => `${prompt.id}@${prompt.version}`),
    ['extract-invoice@2', 'summarise@1'],
  );

  const secret = 'ACCOUNT-9911-ROUTING-2200';
  writeFileSync(join(directory, 'c-broken.v1.json'), JSON.stringify({ ...module, model: secret }));
  assert.throws(
    () => loadPrompts(directory),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('c-broken.v1.json') &&
      error.message.includes('names a model') &&
      !error.message.includes(secret),
  );
  writeFileSync(join(directory, 'c-broken.v1.json'), `{ not json ${secret}`);
  assert.throws(
    () => loadPrompts(directory),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('is not a JSON file') &&
      !error.message.includes(secret),
  );
});

test('a completion is read as the JSON object the schema asked for, and the text never reaches an error', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  assert.deepEqual(
    readJsonCompletion({ text: '{"amount": 12.5}', model: 'm', finishReason: 'stop', usage }),
    { amount: 12.5 },
  );
  const secret = 'ACCOUNT-9911-ROUTING-2200';
  for (const [completion, expected] of [
    [
      { text: `{"amount": ${secret}`, model: 'm', finishReason: 'stop' as const, usage },
      /was not JSON/u,
    ],
    [
      { text: `["${secret}"]`, model: 'm', finishReason: 'stop' as const, usage },
      /not a JSON object/u,
    ],
    [
      { text: `{"a":"${secret}`, model: 'm', finishReason: 'length' as const, usage },
      /stopped early \(length\)/u,
    ],
  ] as const) {
    assert.throws(
      () => readJsonCompletion(completion),
      (error: unknown) =>
        error instanceof Error && expected.test(error.message) && !error.message.includes(secret),
    );
  }
});
