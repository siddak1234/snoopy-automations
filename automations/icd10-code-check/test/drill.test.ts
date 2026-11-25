import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '@autom8x/automation-sdk';
import { answerReview, failureDrill } from '@autom8x/automation-sdk/testing';

import { define } from '../src/automation.js';
import { manifests, platformFor, reading, request } from './fixtures.js';
import { PDF_ID, batchPlatform, batchRequest, childInvoke, page } from './v2-fixtures.js';
import {
  binaries,
  binary,
  bundle,
  docRef,
  ehrPlatform,
  hookInvoke,
  runVisit,
} from './v6-fixtures.js';

/**
 * The SDK's shared failure drill (README, "Build a flow"), on a good run's platform: a made-up note
 * whose run ends with its code (N18.31) kept. v1 calls no provider, so the drill's provider cases
 * are not reached there; its model, timeout and report cases are. v2 reaches the NPI Registry, and
 * v6 the EHR, on its hook's read and its upload's write.
 */
const flow = resolve(import.meta.dirname, '..');
const words = ['README.md', 'words.md']
  .map((name) => join(flow, name))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

const note = reading(['N18.31'], [{ statement: 'CKD stage 3a', categories: ['N18'] }]);

test("§9 the failure drill: every case in the SDK's or this spec's words, never a throw or a raw message", async () => {
  const cases = await failureDrill(define(manifests, { today: () => '2026-10-28' }), {
    request: request(),
    platform: () => platformFor(note, { 'CKD stage 3a': { code: 'N18.31' } }),
    words,
  });
  assert.ok(
    cases.some((one) => one.reached),
    'the drill reached the flow',
  );
});

test('§9 the failure drill on v2: a visit run reaching the NPI Registry, and a batch run', async () => {
  const flow2 = define(manifests, { today: () => '2026-10-28' });
  const child = await failureDrill(flow2, {
    request: childInvoke({ npi: '1234567893' }),
    platform: () => {
      const platform = platformFor(note, { 'CKD stage 3a': { code: 'N18.31' } });
      platform.provider = () =>
        Promise.resolve({ status: 200, body: { results: [{ taxonomies: [] }] } });
      return platform;
    },
    words,
  });
  assert.ok(
    child.some((one) => one.name.startsWith('a') && one.reached),
    'the drill reached the provider',
  );
  const batch = await failureDrill(flow2, {
    request: batchRequest([PDF_ID]),
    platform: () =>
      batchPlatform([{ id: PDF_ID, contentType: 'application/pdf', pageCount: 6 }], {
        [PDF_ID]: [page(1, 'note', 'Jane Doe', '2026-10-12'), page(2, 'note')],
      }),
    words,
  });
  assert.ok(
    batch.some((one) => one.reached),
    'the drill reached the batch run',
  );
});

test('§9 the failure drill on v6: a hook run reading the EHR, and an upload writing to it after its review', async () => {
  const flow6 = define(manifests, { today: () => '2026-10-28' });
  const ehrNote = reading(['N18.30'], [{ statement: 'CKD stage 3a', categories: ['N18'] }], {
    patient: {
      name: 'Jane Doe',
      birthDate: '03/14/1958',
      sex: null,
      recordNumber: '000123',
      provider: null,
    },
  });
  const picks = { 'CKD stage 3a': { code: 'N18.31' } };
  const answers = {
    'notes.search': () => ({ status: 200, body: bundle([docRef([['text/plain', 'b1']])]) }),
    'binary.read': binaries({ b1: binary('text/plain', 'CKD stage 3a, eGFR 52 today.') }),
    'patients.search': () => ({
      status: 200,
      body: bundle([{ resourceType: 'Patient', id: 'p1', birthDate: '1958-03-14' }]),
    }),
    'encounters.search': () => ({
      status: 200,
      body: bundle([{ resourceType: 'Encounter', id: 'e1' }]),
    }),
    'notes.create': () => ({ status: 201, body: null }),
  };
  const hook = await failureDrill(flow6, {
    request: hookInvoke(),
    platform: () => ehrPlatform(ehrNote, picks, answers),
    words,
  });
  assert.ok(
    hook.some((one) => one.name.startsWith('a') && one.reached),
    'the drill reached the EHR',
  );
  const held = await runVisit(ehrPlatform(ehrNote, picks, answers));
  const offered = (held.result as Extract<RunResult, { outcome: 'held' }>).held.decisions ?? [];
  const continued = answerReview(
    held.platform,
    held.request,
    Object.fromEntries(offered.map((one) => [one.id, 'accepted' as const])),
  );
  const write = await failureDrill(flow6, {
    request: continued,
    platform: () => ehrPlatform(ehrNote, picks, answers),
    words,
  });
  assert.ok(
    write.some((one) => one.name.startsWith('a') && one.reached),
    'the drill reached the write',
  );
});
