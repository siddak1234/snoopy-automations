import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SPECIALTIES_FIELD } from '../src/families.js';
import { prompts } from '../src/prompts.js';
import { flow } from './fixtures.js';

/**
 * The manifest against the spec, word for word: section 1 (the card), 2 (the start and its file),
 * 5 (the dropdown) and 6 (the groups and steps, read from the spec's own tables), 7 (the output),
 * and section 4's capabilities, the prompts'.
 */

const manifest = JSON.parse(
  readFileSync(join(flow, '..', '..', 'manifests', 'icd10-code-check.v1.json'), 'utf8'),
);
const spec = readFileSync(join(flow, 'README.md'), 'utf8');

/** A spec table's rows after the heading row whose first cells are `first`. */
function rows(...first: string[]): string[][] {
  const cells = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
  const lines = spec.split('\n');
  const at = lines.findIndex((line) => first.every((cell, i) => cells(line)[i] === cell));
  const out: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    out.push(cells(line));
  }
  return out;
}

test('section 1: the card', () => {
  assert.deepEqual(manifest.display, {
    name: 'ICD-10 Code Check',
    description:
      "Checks a visit's diagnosis codes against the note. You accept or deny each change. Test charts only for now.",
    category: 'Compliance',
    icon: 'Sparkles',
  });
  assert.deepEqual(manifest.pricing, { monthlyPriceUsd: 0 });
});

test('section 2: a manual start with one visit note, PDF, JPEG or PNG, within its limits', () => {
  assert.equal(manifest.trigger.kind, 'manual');
  assert.deepEqual(manifest.trigger.input, [
    {
      key: 'visitNote',
      title: 'Visit note',
      description: 'A PDF or photo of the visit note.',
      control: 'artifact',
      required: false,
    },
  ]);
  assert.deepEqual(manifest.artifacts, {
    acceptedContentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maximumSizeBytes: 3_500_000,
    maximumPdfPages: 30,
    maximumImageSidePixels: 8000,
  });
  assert.equal(manifest.items, undefined, 'no items: a visit is one run');
  assert.deepEqual(manifest.requiredConnections, [], 'section 3: no integration');
});

test("section 4: the capabilities are the prompts', each prompt one row", () => {
  assert.deepEqual(manifest.requiredCapabilities, ['document-extraction', 'classification']);
  assert.deepEqual(prompts.map((p) => [p.id, p.capability]).sort(), [
    ['match-codes', 'classification'],
    ['read-note', 'document-extraction'],
  ]);
});

test('section 5: the specialties dropdown, several picked, Nephrology by default, the code reads it the same', () => {
  const [row] = rows('Section', 'Key');
  assert.deepEqual(manifest.setup, [
    {
      section: row![0],
      key: row![1],
      title: row![2],
      description: row![3],
      control: 'select',
      options: [
        'Nephrology',
        'Internal medicine',
        'Cardiology',
        'Endocrinology',
        'Family practice',
        'Geriatric medicine',
      ],
      multiple: true,
      defaultValue: ['Nephrology'],
      required: true,
      group: row![7],
    },
  ]);
  const { key, control, options, multiple, defaultValue } = manifest.setup[0];
  assert.deepEqual(
    { key, control, options, multiple, defaultValue },
    {
      ...SPECIALTIES_FIELD,
      options: [...SPECIALTIES_FIELD.options],
      defaultValue: [...SPECIALTIES_FIELD.defaultValue],
    },
  );
});

test('section 6: the groups and the steps, ids, titles and descriptions word for word', () => {
  const groups = rows('#', 'Group id').map(([, id, title, description]) => ({
    id,
    title,
    description,
  }));
  assert.deepEqual(
    manifest.groups.map((g: { id: string; title: string; description: string }) => ({
      id: g.id,
      title: g.title,
      description: g.description,
    })),
    groups.map((g) => ({ ...g, description: g.description!.replace(' (platform email)', '') })),
  );
  assert.equal(manifest.groups.at(-1).platform, 'email');
  const steps = rows('Step id', 'Kind').map(([id, kicker, title, description, group]) => ({
    id,
    kicker,
    title,
    description,
    group,
  }));
  assert.deepEqual(manifest.pipeline, steps);
  assert.deepEqual(
    manifest.pipeline.map((s: { id: string }) => s.id),
    [
      'receive',
      'read-note',
      'check-note',
      'find-codes',
      'match-codes',
      'check-codes',
      'decide',
      'save',
    ],
  );
});

test("section 7: the output's fields", () => {
  assert.deepEqual(manifest.outputSchema.required, [
    'patient',
    'visitDate',
    'codeTable',
    'specialties',
    'codesOnNote',
    'verdicts',
    'decisions',
    'finalCodes',
  ]);
  assert.deepEqual(Object.keys(manifest.outputSchema.properties.verdicts.items.properties), [
    'id',
    'code',
    'verdict',
    'suggested',
    'check',
    'quote',
  ]);
  assert.equal(manifest.service.origin, 'http://icd10-code-check-v1.autom8x.internal:8080');
});
