import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { specialtyOptions } from '../src/v2/specialties.js';
import { WORDS_V2 } from '../src/v2/words.js';
import { flow } from './fixtures.js';

/**
 * v2's manifest (the spec's v2 section; `words.md` section 4): the Healthcare department; the NPI
 * and the specialties in setup; several visit notes into one batch run; the batch's own steps and
 * its unit's words; the keyless NPI Registry; the flow's memory; four runs at a time. v1's manifest
 * is unchanged (`manifest.test.ts`); this image serves v3 since (`v3-manifest.test.ts`), and v2 its
 * own pinned image.
 */

const root = join(flow, '..', '..');
const v2 = JSON.parse(
  readFileSync(join(root, 'manifests', 'icd10-code-check.v2.json'), 'utf8'),
) as Record<string, any>;
const menu = JSON.parse(
  readFileSync(join(root, 'contract', 'schemas', 'platform-menu.json'), 'utf8'),
) as { providers: { id: string; auth: string; operations: { name: string }[] }[] };

test('Healthcare, for doctors and coders; four runs at a time', () => {
  assert.equal(v2.display.category, 'Healthcare');
  assert.match(v2.display.description, /For doctors and coders\./u);
  assert.equal(v2.service.maxConcurrentRuns, 4);
  assert.equal(v2.service.origin, 'http://icd10-code-check-v2.autom8x.internal:8080');
});

test("setup: an optional NPI in the screens' words, and the 695 specialties in 16 groups, several", () => {
  const [npi, specialties] = v2.setup;
  assert.deepEqual(
    [npi.key, npi.title, npi.description, npi.control, npi.required],
    ['npi', WORDS_V2.npi, WORDS_V2.npiHelp, 'text', false],
  );
  assert.deepEqual(
    [
      specialties.key,
      specialties.title,
      specialties.control,
      specialties.multiple,
      specialties.required,
    ],
    ['specialties', WORDS_V2.specialties, 'select', true, false],
  );
  assert.equal(specialties.options.length, 695);
  assert.equal(new Set(specialties.options.map((o: { group: string }) => o.group)).size, 16);
  assert.deepEqual(specialties.options, specialtyOptions(), 'the asset, option for option');
});

test('setup: "Learn from this clinic\'s reviews", a toggle on by default (L5)', () => {
  const learn = v2.setup[2];
  assert.deepEqual(
    [learn.key, learn.title, learn.description, learn.control, learn.defaultValue, learn.required],
    ['learn', WORDS_V2.learn, WORDS_V2.learnHelp, 'toggle', true, false],
  );
});

test('the run input: several visit notes into one run, at most 50; a batch of Visits', () => {
  assert.deepEqual(v2.trigger.input, [
    {
      key: 'visitNotes',
      title: 'Visit notes',
      description: WORDS_V2.forWhom,
      control: 'artifact',
      required: false,
      multiple: true,
      maxFiles: 50,
    },
  ]);
  assert.deepEqual(
    v2.batch.pipeline.map((s: { id: string }) => s.id),
    ['chunk', 'categorize', 'organize', 'queue'],
  );
  assert.deepEqual(v2.batch.unitWords, { singular: 'Visit', plural: 'Visits' });
  assert.equal(v2.groups[0].title, WORDS_V2.addVisitNotes);
});

test('the keyless NPI Registry, and the memory capability', () => {
  assert.deepEqual(v2.requiredConnections, [
    {
      providerId: 'nppes',
      displayName: 'NPI Registry',
      purpose: 'Reads your specialties from your NPI when none are picked.',
      scopes: [],
    },
  ]);
  const nppes = menu.providers.find((p) => p.id === 'nppes')!;
  assert.equal(nppes.auth, 'none');
  assert.deepEqual(
    nppes.operations.map((o) => o.name),
    ['npi.lookup'],
  );
  assert.deepEqual(v2.requiredCapabilities, ['document-extraction', 'classification', 'memory']);
});
