import assert from 'node:assert/strict';
import { test } from 'node:test';

import { held, idempotencyKeyFor, partKey, type Step } from '../src/steps.js';
import { RecordingPlatform } from '../src/testing.js';
import { EXAMPLE } from './document-fixture.js';
import { assertValid, validator } from './published-schemas.js';
import { define, invoke, ok } from './runner-fixtures.js';

/**
 * Several side effects in one step (platform BUILD-PLAN 25.4.31; the session's spec, S17): a step
 * has ONE key, and the platform answers a second call under it from the first's record — so a
 * step that writes once per document names a `part` for each, its key `<step key>.<part>` (B-T7);
 * and the documents a step holds with, or the result names, reach the run's result.
 */

test('each part of a step has its own key, the same on every attempt, inside the platform bound', async () => {
  const perDocument: Step = async (context) => {
    for (const part of ['d1', 'd2', 'd2-a', 'd3']) {
      await context.platform.callProvider(
        { providerId: 'quickbooks', operation: 'purchase.create', input: {} },
        { part },
      );
    }
    await context.platform.callProvider({ providerId: 'quickbooks', operation: 'op', input: {} });
    return { outcome: 'ok', summary: 'Recorded' };
  };
  const automation = define({ steps: { receive: ok('r'), validate: ok('v'), post: perDocument } });
  const request = invoke();
  const platform = new RecordingPlatform();
  await automation.execute(request, platform);
  const step = idempotencyKeyFor(request.runId, 'post');
  const keys = platform.providerCalls.map((call) => call.idempotencyKey);
  assert.deepEqual(keys, [`${step}.d1`, `${step}.d2`, `${step}.d2-a`, `${step}.d3`, step]);
  assert.equal(new Set(keys).size, keys.length, 'every part its own key');
  for (const key of keys) assert.match(key, /^[A-Za-z0-9._~:-]{16,128}$/u);

  // The longest step id and part still fit.
  const longest = partKey(idempotencyKeyFor(request.runId, 'a'.repeat(64)), 'z'.repeat(12));
  assert.ok(longest.length <= 128, `${longest.length} characters`);

  const again = new RecordingPlatform();
  await automation.execute(request, again);
  assert.deepEqual(
    again.providerCalls.map((call) => call.idempotencyKey),
    keys,
    'a repeated run sends the same keys',
  );
});

test('a part outside 1-12 lowercase letters, digits or hyphens is refused before anything is sent', async () => {
  for (const part of ['', 'D1', 'd1.a', 'd'.repeat(13), 'd 1']) {
    assert.throws(() => partKey('post-0123456789abcdef', part), /must be 1-12/u, part);
  }
  const bad: Step = async (context) => {
    await context.platform.callProvider(
      { providerId: 'quickbooks', operation: 'op', input: {} },
      { part: 'Doc.1' },
    );
    return { outcome: 'ok', summary: 'x' };
  };
  const platform = new RecordingPlatform();
  await assert.rejects(
    define({ steps: { receive: ok('r'), validate: ok('v'), post: bad } }).execute(
      invoke(),
      platform,
    ),
    /must be 1-12/u,
  );
  assert.equal(platform.providerCalls.length, 0);
});

test('a mail names its part too, and travels with the key attached', async () => {
  const mailing: Step = async (context) => {
    await context.platform.sendMail(
      { to: 'books@example.com', subject: 'Invoice received', body: 'Thank you.' },
      { part: 'results' },
    );
    return { outcome: 'ok', summary: 'Emailed' };
  };
  const request = invoke();
  const platform = new RecordingPlatform();
  await define({ steps: { receive: ok('r'), validate: ok('v'), post: mailing } }).execute(
    request,
    platform,
  );
  const [mail] = platform.mails;
  assert.deepEqual(mail, {
    to: 'books@example.com',
    subject: 'Invoice received',
    body: 'Thank you.',
    idempotencyKey: `${idempotencyKeyFor(request.runId, 'post')}.results`,
  });
  assertValid(validator('automation-mail-request'), mail, 'the mail');
});

test('the documents a step holds with, and those the result names, reach the run result', async () => {
  const holding: Step = () =>
    Promise.resolve(
      held({
        summary: 'Waiting for approval',
        heldReason: 'Document 1: new vendor.',
        state: { kept: true },
        documents: [EXAMPLE],
      }),
    );
  const heldRun = await define({
    steps: { receive: ok('r'), validate: holding, post: ok('p') },
  }).execute(invoke(), new RecordingPlatform());
  assert.deepEqual(heldRun, {
    outcome: 'held',
    held: { stepId: 'validate', reason: 'Document 1: new vendor.', state: { kept: true } },
    documents: [EXAMPLE],
  });

  const done = await define({
    result: () => ({ summary: '1 receipt: 1 recorded in QuickBooks.', documents: [EXAMPLE] }),
  }).execute(invoke(), new RecordingPlatform());
  assert.deepEqual(done, {
    outcome: 'success',
    summary: '1 receipt: 1 recorded in QuickBooks.',
    documents: [EXAMPLE],
  });
  // A held step without documents adds none.
  const bare = await define({
    steps: {
      receive: ok('r'),
      validate: () =>
        Promise.resolve(held({ summary: 'Waiting', heldReason: 'Needs a look.', state: {} })),
      post: ok('p'),
    },
  }).execute(invoke(), new RecordingPlatform());
  assert.equal('documents' in bare, false);
});
