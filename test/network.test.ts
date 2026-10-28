import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { filesUnder, flowIds, root } from '../scripts/review-rows.js';
import { networkProblems } from './network.js';

/**
 * The SDK is the only way out (CLAUDE.md rule 4; Round 21, D2.2 "Enforced"): no flow's code — nor
 * the template a flow is scaffolded from — calls the network itself. Banned under
 * `automations/*\/src` and `templates/automation/src`: `fetch(`, Node's network modules, `undici`
 * and the vendor SDKs and HTTP clients a flow might reach for. A provider is called through
 * `callProvider`, a model through `callModel`, mail through `sendMail`.
 */

test('no flow, and not the template, calls the network itself', () => {
  const roots = [
    ...flowIds().map((id) => join(root, 'automations', id, 'src')),
    join(root, 'templates', 'automation', 'src'),
  ];
  const offenders = roots
    .flatMap((directory) => filesUnder(directory))
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      networkProblems(readFileSync(file, 'utf8')).map((p) => `${relative(root, file)}:${p}`),
    );
  assert.deepEqual(offenders, []);
});

test('each way out is caught, and a comment or an SDK call is not', () => {
  assert.deepEqual(networkProblems("const answer = await fetch('https://vendor.test');"), [
    '1: fetch(',
  ]);
  assert.deepEqual(networkProblems("import { request } from 'node:https';"), [
    '1: imports node:https',
  ]);
  assert.deepEqual(networkProblems("import http from 'http';"), ['1: imports http']);
  assert.deepEqual(networkProblems("const { fetch: f } = await import('undici');"), [
    '1: imports undici',
  ]);
  assert.deepEqual(networkProblems("import OpenAI from 'openai';"), ['1: imports openai']);
  assert.deepEqual(networkProblems('const s = new WebSocket(url);'), ['1: a socket']);
  assert.deepEqual(networkProblems('// fetch( is how it is not done'), []);
  assert.deepEqual(
    networkProblems('await platform.callProvider(request); prefetch(x); a.fetch(y)'),
    [],
  );
});
