import assert from 'node:assert/strict';
import { test } from 'node:test';

import { define } from '../src/automation.js';
import { FAILURES } from '../src/words.js';
import { manifests, retiredFile } from './fixtures.js';
import { batchPlatform, batchRequest } from './v2-fixtures.js';

/**
 * v5's manifest (README, "v5"; the owner's item 1 on build 43 and "Yes to all 3", 2026-11-14):
 * v4's, byte for byte, but its version, its own origin and service account, and its file field
 * `visitNotes` required — the platform refuses a run without a file before it starts. It keeps
 * `dataProtection: 'hipaa'`. v4 was retired 2026-11-14 and v5 on 2026-11-25, when v6 was live
 * (`v6-manifest.test.ts`); v6 still runs v5's code, so the suite does too.
 */

type Json = Record<string, any>;
const v4 = JSON.parse(retiredFile(4)) as Json; // retired 2026-11-14; git keeps its file
const v5 = JSON.parse(retiredFile(5)) as Json; // retired 2026-11-25; git keeps its file

/** A manifest without what v5 changes: its version, its service's names, its file's `required`. */
function withoutV5(manifest: Json): Json {
  const { version: _v, service, trigger, ...rest } = manifest;
  const { origin: _o, serviceAccount: _a, ...kept } = service as Json;
  const [field, ...others] = (trigger as Json).input as Json[];
  const { required: _r, ...fileField } = field!;
  return { ...rest, service: kept, trigger: { ...trigger, input: [fileField, ...others] } };
}

test("v5 is v4's manifest but its version, its own origin and service account, and its file required", () => {
  assert.deepEqual(withoutV5(v5), withoutV5(v4));
  assert.deepEqual(
    [
      v5.version,
      v5.trigger.input[0].key,
      v5.trigger.input[0].required,
      v4.trigger.input[0].required,
    ],
    [5, 'visitNotes', true, false],
  );
  assert.equal(v5.dataProtection, 'hipaa');
  assert.equal(v5.service.origin, 'http://icd10-code-check-v5.autom8x.internal:8080');
  assert.equal(v5.service.serviceAccount, 'icd10-code-check-v5@autom8x.iam.gserviceaccount.com');
});

test('a v5 batch run that still names no file stops in its own words, before any read or call', async () => {
  const platform = batchPlatform([], {});
  const request = { ...batchRequest([]), templateVersion: 5 };
  const result = await define(manifests, { today: () => '2026-10-28' }).execute(request, platform);
  assert.deepEqual(result, { outcome: 'failed', failureReason: FAILURES.noFile });
  assert.deepEqual([platform.artifactReads, platform.modelCalls], [[], []]);
});
