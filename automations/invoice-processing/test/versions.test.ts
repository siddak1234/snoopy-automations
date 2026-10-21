import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { manifestsRoot } from './fixtures.js';

/**
 * What each version of the manifest changed from the one before it — every other field held equal
 * (moved here from `manifest.test.ts`, which holds the served version's own fields, for the
 * 400-line ceiling). A registered version is immutable; each newer one is its predecessor but for
 * what its test names.
 */

type Group = Record<string, unknown> & { id: string; title: string };
type Manifest = Record<string, unknown> & {
  version: number;
  display: Record<string, unknown>;
  groups: Group[];
  service: Record<string, unknown>;
};

const read = (version: number) =>
  JSON.parse(
    readFileSync(join(manifestsRoot, `invoice-processing.v${version}.json`), 'utf8'),
  ) as Manifest;
const manifest = read(7);
const v6 = read(6);
const v5 = read(5);
const v4 = read(4);

test('v5 is v4 with step 5 named "Run completed" (done only when the run succeeds) — nothing else moved', () => {
  const step5 = (each: Manifest) => each.groups.find((group) => group.id === 'email');
  assert.deepEqual(step5(v4), {
    id: 'email',
    title: 'Email sent',
    description: 'The results are emailed.',
    platform: 'email',
  });
  assert.deepEqual(step5(v5), {
    id: 'email',
    title: 'Run completed',
    description: 'Done when the run succeeds.',
    platform: 'email',
  });
  const without = (each: Manifest) => ({
    ...each,
    version: undefined,
    groups: each.groups.filter((group) => group.id !== 'email'),
    service: { ...each.service, origin: undefined, serviceAccount: undefined },
  });
  assert.deepEqual(without(v5), without(v4));
});

test("v6 is v5 but for its version and its own container: what changed is in the code's results, not the manifest", () => {
  const without = (each: Manifest) => ({
    ...each,
    version: undefined,
    service: { ...each.service, origin: undefined, serviceAccount: undefined },
  });
  assert.deepEqual(without(v6), without(v5));
  assert.notEqual(v6.service.origin, v5.service.origin);
  assert.notEqual(v6.service.serviceAccount, v5.service.serviceAccount);
});

test('v7 is v6 but for its version, its own container and its words for its documents — "Invoice" and "Invoices" (the platform\'s BUILD-PLAN 27.3.2)', () => {
  const without = (each: Manifest) => ({
    ...each,
    version: undefined,
    display: { ...each.display, documentWords: undefined },
    service: { ...each.service, origin: undefined, serviceAccount: undefined },
  });
  assert.deepEqual(without(manifest), without(v6));
  assert.deepEqual((manifest.display as { documentWords?: unknown }).documentWords, {
    singular: 'Invoice',
    plural: 'Invoices',
  });
  assert.equal((v6.display as { documentWords?: unknown }).documentWords, undefined);
  assert.notEqual(manifest.service.origin, v6.service.origin);
  assert.notEqual(manifest.service.serviceAccount, v6.service.serviceAccount);
});
