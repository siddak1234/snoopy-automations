import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readManifests } from '@autom8x/automation-sdk';
import { failureDrill } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { platformFor, reading, request } from './fixtures.js';

/**
 * The SDK's shared failure drill (README, "Build a flow"), on a good run's platform: a made-up note
 * whose run ends with its code (N18.31) kept. The flow calls no provider,
 * so the drill's provider cases are not reached; its model, timeout and report cases are.
 */
const flow = resolve(import.meta.dirname, '..');
const manifests = readManifests(join(flow, '..', '..', 'manifests'), TEMPLATE_ID);
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
