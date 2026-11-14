import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import type { ModelRequest } from '@autom8x/automation-sdk';
import type { RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { define } from '../src/automation.js';
import { HEALTH_VERSIONS, MODELS } from '../src/models.js';
import { prompts } from '../src/prompts.js';
import { manifests, reading, retiredFile } from './fixtures.js';
import { PDF_ID, batchPlatform, batchRequest, page, runChild } from './v2-fixtures.js';

/**
 * v4's manifest (README, "v4"; the platform's ADR-0049, C1 and C2): v3's, word for word, with
 * `dataProtection: 'hipaa'` — its runs carry health data — and its own origin and service account;
 * this image served v4 alone until v5 (`v5-manifest.test.ts`). Its calls name no models, so the
 * platform's BAA gateway serves them from its own list (an automation's own `models` it refuses);
 * and no patient data reaches any output schema's `enum`, `const` or `pattern` (the audit's H-W6,
 * Anthropic's "Do not include PHI in JSON schema definitions").
 */

type Json = Record<string, any>;
// v3 and v4 left `manifests/` once retired: git keeps them (`retiredFile`).
const read = (version: number): Json => JSON.parse(retiredFile(version)) as Json;
const v3 = read(3);
const v4 = read(4);

/** A manifest without what v4 adds or must change: its version, its service's names, the field. */
function withoutV4(manifest: Json): Json {
  const { version: _v, service, dataProtection: _d, ...rest } = manifest;
  const { origin: _o, serviceAccount: _a, ...kept } = service as Json;
  return { ...rest, service: kept };
}

test("v4 is v3's manifest, word for word, but its version, its own origin and service account, and dataProtection hipaa", () => {
  assert.deepEqual(withoutV4(v4), withoutV4(v3));
  assert.equal(v4.version, 4);
  assert.equal(v4.dataProtection, 'hipaa');
  assert.equal(v3.dataProtection, undefined, 'v3 stays as registered');
  assert.equal(v4.service.origin, 'http://icd10-code-check-v4.autom8x.internal:8080');
  assert.equal(v4.service.serviceAccount, 'icd10-code-check-v4@autom8x.iam.gserviceaccount.com');
  assert.match(v4.display.description, /Test charts only for now\.$/u, 'no real charts yet');
});

test("HEALTH_VERSIONS is every version whose manifest says dataProtection 'hipaa'", () => {
  // Every version: the retired ones from git, the newest from `manifests/` (`manifests`).
  const declared = (manifests as Json[])
    .filter((manifest) => manifest.dataProtection === 'hipaa')
    .map((manifest) => manifest.version as number)
    .sort((a, b) => a - b);
  assert.deepEqual(
    [...HEALTH_VERSIONS].sort((a, b) => a - b),
    declared,
  );
});

const note = reading(
  ['I10', 'N18.30'],
  [
    { statement: 'Hypertension', categories: ['I10'] },
    { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
  ],
);

/** A visit's calls on `version`: its read and its match. */
async function visitCalls(version: number): Promise<ModelRequest[]> {
  const ran = await runChild(note, { CKD: { code: 'N18.31' } }, { version });
  assert.notEqual(ran.result.outcome, 'failed', JSON.stringify(ran.result).slice(0, 300));
  return ran.platform.modelCalls;
}

/** A batch run's calls on `version`: its pages sorted — 7, past the 5 a single file is routed at. */
async function batchCalls(version: number): Promise<ModelRequest[]> {
  const pages = Array.from({ length: 7 }, (_, at) =>
    at === 0 ? page(1, 'note', 'Jane Doe', '2026-10-12') : page(at + 1, 'note'),
  );
  const platform: RecordingPlatform = batchPlatform(
    [{ id: PDF_ID, contentType: 'application/pdf', pageCount: 7 }],
    { [PDF_ID]: pages },
  );
  const request = { ...batchRequest([PDF_ID]), templateVersion: version };
  const result = await define(manifests, { today: () => '2026-10-28' }).execute(request, platform);
  assert.equal(result.outcome, 'success', JSON.stringify(result).slice(0, 300));
  return platform.modelCalls;
}

test('v4: every call names no models and leaves no maker out; v3 keeps its two', async () => {
  const v4Calls = [...(await batchCalls(4)), ...(await visitCalls(4))];
  assert.deepEqual(
    v4Calls.map((call) => call.capability),
    ['document-extraction', 'document-extraction', 'classification'],
    'the sort, the read and the match',
  );
  for (const call of v4Calls) {
    assert.equal(call.models, undefined, 'the BAA gateway refuses an automation’s own models');
    assert.equal(call.excludeModelAuthors, undefined);
  }
  const v3Calls = [...(await batchCalls(3)), ...(await visitCalls(3))];
  assert.equal(v3Calls.length, 3);
  for (const call of v3Calls) assert.deepEqual(call.models, MODELS, 'v3 stays on OpenRouter');
});

/** Every `enum`, `const` and `pattern` in a schema, by its path. */
function fixedValues(schema: unknown, path = ''): [string, unknown][] {
  if (Array.isArray(schema))
    return schema.flatMap((each, at) => fixedValues(each, `${path}/${at}`));
  if (typeof schema !== 'object' || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(['enum', 'const', 'pattern'].includes(key)
      ? [[`${path}/${key}`, value] as [string, unknown]]
      : []),
    ...fixedValues(value, `${path}/${key}`),
  ]);
}

test('H-W6: no patient data in any output schema v4 sends or declares: each is its prompt file’s, its fixed values the reviewed ones', async () => {
  const calls = [...(await batchCalls(4)), ...(await visitCalls(4))];
  const sent = new Map<string, unknown>();
  for (const call of calls) {
    // The schema sent is a registered prompt file's, byte for byte: never built from a run.
    assert.ok(
      prompts.some((prompt) => isDeepStrictEqual(prompt.outputSchema, call.outputSchema)),
      'a schema no prompt file holds',
    );
    for (const [where, value] of fixedValues(call.outputSchema)) sent.set(where, value);
  }
  // The reviewed list: a new enum, const or pattern is read for patient data before it is added.
  assert.deepEqual(Object.fromEntries(sent), {
    '/properties/pages/items/properties/segments/items/properties/kind/enum': [
      'note',
      'lab',
      'cover',
      'separator',
      'other',
    ],
    '/properties/diagnoses/items/properties/certainty/enum': ['confirmed', 'uncertain'],
  });
  const text = JSON.stringify([...sent.values()]);
  for (const patient of ['Jane Doe', '2026-10-12', 'Hypertension', 'N18']) {
    assert.ok(!text.includes(patient), `${patient} in a schema`);
  }
  assert.deepEqual(fixedValues(v4.outputSchema), [], "the manifest's output schema fixes none");
});
