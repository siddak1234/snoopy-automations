import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { manifestProblems, type Json } from './manifest-rules.js';

/**
 * A flow's items (the platform's ADR-0046) and a run's file field (its ADR-0030), held to the
 * platform's validator rules the schema cannot say (`test/manifest-items.ts`), each refusal
 * bitten in the platform's words on a copy of Candidate Reviewer v1 changed to break it.
 */

const v1 = JSON.parse(
  readFileSync(
    join(resolve(import.meta.dirname, '..', 'manifests'), 'candidate-reviewer.v1.json'),
    'utf8',
  ),
) as Json & { items: Json & { fields: Json[]; pipeline: Json[]; file: Json }; trigger: Json };

const withItems = (items: Json): Json => ({ ...v1, items: { ...v1.items, ...items } });
const [department, role] = v1.items.fields as [Json, Json];

test('Candidate Reviewer v1 passes every rule', () => {
  assert.deepEqual(manifestProblems(v1), []);
});

test('the rules refuse what the platform refuses', () => {
  const cases: [string, Json, string][] = [
    [
      'items on a scheduled flow',
      { ...v1, trigger: { kind: 'schedule', everySeconds: 3600 } },
      "items: needs trigger.kind 'manual': a person makes an item and starts its runs",
    ],
    [
      'items with no file to make one from',
      Object.fromEntries(Object.entries(v1).filter(([key]) => key !== 'artifacts')),
      'items: needs an artifacts block: an item is made from a file',
    ],
    [
      'a field declared twice',
      withItems({ fields: [department, { ...role, key: 'department' }], titleField: 'department' }),
      'items.fields[1].key: is declared more than once',
    ],
    [
      'options on a text box',
      withItems({ fields: [department, { ...role, options: ['A'] }] }),
      "items.fields[1].options: is only meaningful on a 'select' field",
    ],
    [
      'a length on a select',
      withItems({ fields: [{ ...department, maxLength: 40 }, role] }),
      "items.fields[0].maxLength: is only meaningful on a 'text' field",
    ],
    [
      'a select with no option',
      withItems({ fields: [{ ...department, options: [], defaultValue: undefined }, role] }),
      'items.fields[0].options: must declare at least 1 option',
    ],
    [
      'a default that is no option',
      withItems({ fields: [{ ...department, defaultValue: 'Kitchen' }, role] }),
      'items.fields[0].defaultValue: must be one of options',
    ],
    [
      'a title field nobody declared',
      withItems({ titleField: 'name' }),
      'items.titleField: must name a field of items.fields',
    ],
    [
      'a title field a person may leave empty',
      withItems({ fields: [department, { ...role, required: false }] }),
      'items.titleField: must name a required field: its value names the item',
    ],
    [
      'grouped by a text box',
      withItems({ groupField: 'role' }),
      "items.groupField: must name a 'select' field of items.fields",
    ],
    [
      'a file under a field key',
      withItems({ file: { ...v1.items.file, key: 'role' } }),
      'items.file.key: must not be a key of items.fields',
    ],
    [
      'a file under the run input key',
      withItems({ file: { ...v1.items.file, key: 'resumeFile' } }),
      'items.file.key: must not be a key of trigger.input',
    ],
    [
      'an item step twice',
      withItems({ pipeline: [...v1.items.pipeline, v1.items.pipeline[0]!] }),
      'items.pipeline[3].id: is declared more than once',
    ],
    [
      'an item step that is a run step',
      withItems({ pipeline: [{ id: 'score', title: 'Scored', description: 'Scored.' }] }),
      'items.pipeline[0].id: is a pipeline step id: an item run reports its own steps',
    ],
    [
      'a reading schema the platform cannot hold',
      withItems({
        outputSchema: { type: 'object', properties: { title: { type: 'string', pattern: '^A' } } },
      }),
      'items.outputSchema.properties.title: uses pattern, which the platform cannot hold an output to',
    ],
    [
      'a required file field',
      {
        ...v1,
        trigger: { ...v1.trigger, input: [{ ...(v1.trigger.input as Json[])[0], required: true }] },
      },
      'trigger.input[0].required: must be false for an artifact control',
    ],
    [
      'a file field with a default',
      {
        ...v1,
        trigger: {
          ...v1.trigger,
          input: [{ ...(v1.trigger.input as Json[])[0], defaultValue: 'x' }],
        },
      },
      'trigger.input[0].defaultValue: is not meaningful for an artifact control',
    ],
  ];
  for (const [what, manifest, refusal] of cases) {
    assert.ok(
      manifestProblems(manifest).includes(refusal),
      `${what}: ${manifestProblems(manifest).join('; ')}`,
    );
  }
});
