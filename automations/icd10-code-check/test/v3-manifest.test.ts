import assert from 'node:assert/strict';
import { test } from 'node:test';

import { npiOf } from '../src/v2/specialties.js';
import { WORDS_V2, WORDS_V3 } from '../src/v2/words.js';
import { retiredFile } from './fixtures.js';

/**
 * v3's manifest (the spec's "v3"; `words.md` section 5): v2's, word for word, with its setup in
 * three sections — NPI, Specialty, Integrations (TestFlight build 34, F3) — held to the platform's
 * rules for them both ways (ADR-0048 amendment 5; `contract/README.md`, "`setup[]`"), and the NPI
 * box's example, a valid NPI (F2). The image serves v5 alone (`v5-manifest.test.ts`).
 */

type Json = Record<string, any>;
// v2 and v3 left `manifests/` once retired: git keeps them (`retiredFile`).
const read = (version: number): Json => JSON.parse(retiredFile(version)) as Json;
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

test('F3: the setup in three sections, NPI · Specialty · Integrations, each holding its own setting', () => {
  const { npi, specialty, integrations } = WORDS_V3.setupSections;
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

/**
 * Whether a 10-digit number is a valid NPI by CMS's check digit (the NPI final rule, ISO standard
 * check digit): the Luhn formula over the card issuer prefix 80840 and the NPI's 10 digits. By hand
 * for 1234567893: the first nine doubled from the right (9, 7, 5, 3, 1) give 9+8+5+6+1+4+6+2+2 =
 * 43, the prefix adds 24, 67; the next ten is 70, so the check digit is 3.
 */
function validNpi(npi: string): boolean {
  if (!/^\d{10}$/u.test(npi)) return false;
  let sum = 0;
  [...`80840${npi}`].reverse().forEach((digit, at) => {
    const n = Number(digit) * (at % 2 === 1 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}

test('F2: the NPI box\'s example, "10 digits, e.g. 1234567893", in place of "Optional": a valid NPI', () => {
  const [npi] = v3.setup as Json[];
  assert.equal(npi!.example, WORDS_V3.npiExample);
  assert.ok(npi!.example.length <= 40, "the platform's example bound");
  assert.equal(npi!.description, WORDS_V2.npiHelp, "v2's line stays");
  const shown = /\d{10}/u.exec(npi!.example)![0];
  assert.ok(validNpi(shown), `${shown} passes the CMS check digit`);
  assert.equal(npiOf({ npi: shown }), shown, 'the flow reads it as an NPI');
  for (const last of '012456789') {
    assert.equal(validNpi(`${shown.slice(0, 9)}${last}`), false, `the rule refuses …${last}`);
  }
  assert.equal(
    (v3.setup as Json[]).filter((field) => field.example !== undefined).length,
    1,
    'the NPI alone carries one',
  );
});
