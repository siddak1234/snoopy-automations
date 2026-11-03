import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SERVED_VERSIONS } from '../src/automation.js';
import { WORDS_V3 } from '../src/v2/words.js';
import { flow } from './fixtures.js';

/**
 * v3's manifest (the spec's "v3"; `words.md` section 5): v2's, word for word, with its setup in
 * three sections — NPI, Specialty, Integrations (TestFlight build 34, F3) — held to the platform's
 * rules for them both ways (ADR-0048 amendment 5; `contract/README.md`, "`setup[]`"); this image
 * serves v3 alone.
 */

type Json = Record<string, any>;
const root = join(flow, '..', '..');
const read = (version: number): Json =>
  JSON.parse(
    readFileSync(join(root, 'manifests', `icd10-code-check.v${version}.json`), 'utf8'),
  ) as Json;
const v2 = read(2);
const v3 = read(3);

/** A manifest without what v3 adds or must change: its version, its service's names, its sections. */
function withoutV3(manifest: Json): Json {
  const { version: _v, service, setupSections: _s, setup, ...rest } = manifest;
  const { origin: _o, serviceAccount: _a, ...kept } = service as Json;
  return {
    ...rest,
    service: kept,
    setup: (setup as Json[]).map(({ sectionId: _id, example: _e, ...field }) => field),
  };
}

test("v3 is v2's manifest, word for word, but its version, its own origin and service account, and its setup's sections", () => {
  assert.deepEqual(withoutV3(v3), withoutV3(v2));
  assert.equal(v3.version, 3);
  assert.equal(v3.service.origin, 'http://icd10-code-check-v3.autom8x.internal:8080');
  assert.equal(v3.service.serviceAccount, 'icd10-code-check-v3@autom8x.iam.gserviceaccount.com');
});

test('this image serves v3 alone', () => {
  assert.deepEqual(SERVED_VERSIONS, [3]);
  const dockerfile = readFileSync(join(flow, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY --chown=node:node manifests\/icd10-code-check\.v3\.json /mu);
});

test('F3: the setup in three sections, NPI · Specialty · Integrations, each holding its own setting', () => {
  const { npi, specialty, integrations } = WORDS_V3.sections;
  assert.deepEqual(v3.setupSections, [
    { id: 'npi', title: npi },
    { id: 'specialty', title: specialty },
    { id: 'integrations', title: integrations },
  ]);
  assert.deepEqual(
    (v3.setup as Json[]).map((field) => [field.key, field.sectionId]),
    [
      ['npi', 'npi'],
      ['specialties', 'specialty'],
      ['learn', 'integrations'],
    ],
    "the NPI's field in NPI, the specialties in Specialty, the Learn toggle in Integrations",
  );
  // The platform's rules, both ways: 2 to 6, ids once, titles of 1 to 40; every setting names a
  // declared section and every section holds a setting.
  const ids = (v3.setupSections as Json[]).map((section) => section.id as string);
  assert.ok(ids.length >= 2 && ids.length <= 6);
  assert.equal(new Set(ids).size, ids.length);
  for (const { title } of v3.setupSections as Json[])
    assert.ok(title.length >= 1 && title.length <= 40);
  for (const field of v3.setup as Json[]) assert.ok(ids.includes(field.sectionId), field.key);
  for (const id of ids)
    assert.ok(
      (v3.setup as Json[]).some((field) => field.sectionId === id),
      id,
    );
  assert.equal(v2.setupSections, undefined, "v2 keeps today's four fixed sections");
});
