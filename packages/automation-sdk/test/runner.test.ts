import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Step, idempotencyKeyFor } from '../src/runner.js';
import { RecordingPlatform } from '../src/testing.js';
import { TEMPLATE, define, extract, invoke, manifest, ok } from './runner-fixtures.js';

/**
 * The step runner against a recording platform, part one: the pipeline in order,
 * the definition refused when code and manifests disagree, the pinned version's
 * pipeline, and one key per run and step on every side effect.
 */

test('the declared pipeline runs in order, each step reported under its id, and the result follows', async () => {
  const platform = new RecordingPlatform();
  const result = await define().execute(invoke(), platform);
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome, step.summary]),
    [
      ['receive', 'ok', 'Received'],
      ['validate', 'ok', 'Validated'],
      ['post', 'ok', 'Posted'],
    ],
  );
  assert.deepEqual(result, { outcome: 'success', output: { received: true }, summary: 'Done' });
  assert.equal(platform.results.length, 0, 'the shell reports the result, not the runner');
});

test('an automation is refused at definition when its steps and its manifests disagree', () => {
  // A step the code can report that no served manifest declares: the platform
  // would refuse it with 422 and not store it, so it is refused here first.
  assert.throws(
    () => define({ steps: { receive: ok('r'), validate: ok('v'), post: ok('p'), audit: ok('a') } }),
    /step "audit" is not declared by any manifest under-test serves/u,
  );
  // A declared step with nothing behind it would fail every run at that step.
  assert.throws(
    () => define({ steps: { receive: ok('r'), validate: ok('v') } }),
    /under-test v1 declares step "post", which the code does not implement/u,
  );
  assert.throws(() => define({ manifests: [] }), /serves no manifest version/u);
  assert.throws(
    () =>
      define({
        manifests: [{ ...manifest(1, ['receive', 'validate', 'post']), templateId: 'other' }],
      }),
    /cannot serve a manifest for other/u,
  );
});

test('a run pinned to a version this container does not serve is failed, not guessed at', async () => {
  const platform = new RecordingPlatform();
  const result = await define().execute(invoke({ templateVersion: 7 }), platform);
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: 'this container serves under-test v1, not v7',
  });
  assert.equal(platform.steps.length, 0, 'nothing was reported');
});

test('the pipeline of the PINNED version runs: a v1 run never reaches the step only v2 declares', async () => {
  const automation = define({
    manifests: [manifest(1, ['receive', 'post']), manifest(2, ['receive', 'post', 'notify'])],
    steps: { receive: ok('r'), post: ok('p'), notify: ok('n') },
  });
  const v1 = new RecordingPlatform();
  await automation.execute(invoke({ templateVersion: 1 }), v1);
  assert.deepEqual(
    v1.steps.map((step) => step.stepId),
    ['receive', 'post'],
  );
  const v2 = new RecordingPlatform();
  await automation.execute(invoke({ templateVersion: 2 }), v2);
  assert.deepEqual(
    v2.steps.map((step) => step.stepId),
    ['receive', 'post', 'notify'],
  );
  assert.deepEqual(automation.versions, [1, 2]);
});

test('one idempotency key per run and step, attached to every provider request and mail', async () => {
  const seen: { stepId: string; key: string }[] = [];
  const posting: Step = async (context) => {
    await context.platform.callProvider({ providerId: 'google', operation: 'op', input: {} });
    await context.platform.sendMail({ to: 'a@example.com', subject: 's', body: 'b' });
    seen.push({ stepId: context.stepId, key: context.idempotencyKey });
    return { outcome: 'ok', summary: 'posted' };
  };
  const automation = define({ steps: { receive: posting, validate: posting, post: posting } });

  const first = new RecordingPlatform();
  const request = invoke();
  await automation.execute(request, first);
  const keys = first.providerCalls.map((call) => call.idempotencyKey);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 3, 'every step of the run carries its own key');
  assert.deepEqual(
    first.mails.map((mail) => mail.idempotencyKey),
    keys,
    'the mail of a step carries the same key as its provider call',
  );
  for (const [index, key] of keys.entries()) {
    assert.equal(key, seen[index]?.key, 'the key the step saw is the key that travelled');
    assert.equal(key, idempotencyKeyFor(request.runId, seen[index]!.stepId));
    assert.match(key, /^[A-Za-z0-9._~:-]{16,128}$/u, "inside the platform's bound and alphabet");
  }

  // A re-run of the same run id derives the same keys: the side effect is not posted twice.
  const replay = new RecordingPlatform();
  await automation.execute(request, replay);
  assert.deepEqual(
    replay.providerCalls.map((call) => call.idempotencyKey),
    keys,
  );
  // Another run derives other keys.
  const other = new RecordingPlatform();
  await automation.execute(invoke({ runId: 'aaaaaaaa-0000-4000-8000-000000000002' }), other);
  assert.notDeepEqual(
    other.providerCalls.map((call) => call.idempotencyKey),
    keys,
  );
});

test('the key is bounded for the longest declared step id and the longest run id', () => {
  const key = idempotencyKeyFor('r'.repeat(300), 'a'.repeat(64));
  assert.ok(key.length >= 16 && key.length <= 128, `${key.length} characters`);
  assert.match(key, /^[A-Za-z0-9._~:-]+$/u);
  assert.notEqual(idempotencyKeyFor('run', 'receive'), idempotencyKeyFor('run', 'validate'));
});

test('the automation names its template, versions, steps and prompts for a conformance test to read', () => {
  const automation = define({
    manifests: [manifest(1, ['receive', 'validate', 'post'], ['document-extraction'])],
    prompts: [extract],
  });
  assert.equal(automation.templateId, TEMPLATE);
  assert.deepEqual(automation.versions, [1]);
  assert.deepEqual(automation.steps, ['receive', 'validate', 'post']);
  assert.deepEqual(automation.prompts, [extract]);
});
