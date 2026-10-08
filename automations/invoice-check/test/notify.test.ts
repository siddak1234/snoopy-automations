import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { idempotencyKeyFor } from '@autom8x/automation-sdk';
import {
  type ProblemInput,
  RecordingPlatform,
  refusalFixture,
} from '@autom8x/automation-sdk/testing';

import { automation, invokeAt, manifestsRoot, output } from './fixtures.js';

/** v2 to v4: the outcome email, through the platform and nowhere else (its ADR-0021). */

test('a v1 run reports no notify step and calls no provider, even with an address in its config', async () => {
  // The pinned version's pipeline is what runs: v1 declares no `notify`, so the
  // step is never started — not because the code remembered to check a version.
  const platform = new RecordingPlatform();
  const result = await automation.execute(invokeAt(1, { holdAboveAmount: 500 }), platform);
  assert.equal(result.outcome, 'success');
  assert.equal(platform.providerCalls.length, 0);
  assert.equal(platform.mails.length, 0);
  assert.deepEqual(
    platform.steps.map((step) => step.stepId),
    ['receive', 'validate', 'post'],
  );
  assert.ok(!('notified' in output(result)));
});

for (const version of [2, 3, 4]) {
  test(`a v${version} run emails the outcome through the platform, naming no account`, async () => {
    const platform = new RecordingPlatform();
    const request = invokeAt(version);
    const result = await automation.execute(request, platform);

    assert.equal(platform.providerCalls.length, 0, 'no provider, no grant, no mailbox named here');
    assert.equal(platform.mails.length, 1);
    const [mail] = platform.mails;
    assert.equal(mail?.to, 'vendor@example.com');
    assert.equal(mail?.subject, 'Invoice INV-1001 — $120.50 automatically, within threshold');
    assert.equal(
      mail?.body,
      'Invoice INV-1001 from Northwind Trading\nAmount: $120.50\nOutcome: recorded automatically, within threshold',
    );
    assert.equal(mail?.idempotencyKey, idempotencyKeyFor(request.runId, 'notify'));
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.equal(notify?.outcome, 'ok');
    assert.equal(output(result).notified, true);
  });

  test(`a v${version} run with no address sends nothing and reports no notify step`, async () => {
    const platform = new RecordingPlatform();
    const result = await automation.execute(invokeAt(version, { notifyEmail: '  ' }), platform);
    assert.equal(platform.mails.length, 0);
    assert.ok(!platform.steps.some((step) => step.stepId === 'notify'));
    assert.ok(!('notified' in output(result)));
  });

  test(`a refused v${version} mail is a failed step, not a swallowed one, and not a failed run`, async () => {
    const platform = new RecordingPlatform();
    platform.mail = () =>
      Promise.reject(
        refusalFixture('mail', {
          status: 400,
          code: 'BAD_REQUEST',
          detail: 'to must be a single mailbox address',
          details: { field: 'to' },
        }),
      );
    const result = await automation.execute(invokeAt(version, { notifyEmail: 'a@b' }), platform);
    assert.equal(
      platform.mails.length,
      1,
      "the address is the platform's to refuse, and it was asked",
    );
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.equal(notify?.outcome, 'failed');
    assert.match(notify?.summary ?? '', /could not be emailed/u);
    assert.equal(output(result).notified, false);
    assert.equal(result.outcome, 'success');
  });

  test(`a v${version} notify summary carries neither the address nor the message`, async () => {
    const platform = new RecordingPlatform();
    await automation.execute(
      invokeAt(version, { notifyEmail: 'private.person@example.com' }),
      platform,
    );
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.ok(notify);
    assert.doesNotMatch(notify.summary, /private\.person/u);
    assert.doesNotMatch(notify.summary, /Outcome: recorded/u);
  });
}

test('a line break in the reference cannot reach the subject', async () => {
  const platform = new RecordingPlatform();
  const request = invokeAt(3);
  (request.input as { reference: string }).reference = 'INV-9\r\nBcc: attacker@evil.example';
  await automation.execute(request, platform);
  assert.equal(platform.mails.length, 1);
  assert.doesNotMatch(platform.mails[0]!.subject, /[\r\n]/u);
  assert.ok(platform.mails[0]!.subject.length <= 200);
});

test('the subject and body are bounded, and no line is lost to the bounding', async () => {
  const platform = new RecordingPlatform();
  const request = invokeAt(3);
  const input = request.input as { reference: string; vendor: string };
  input.reference = 'X'.repeat(300);
  input.vendor = '\u{1F600}'.repeat(6_000);
  await automation.execute(request, platform);
  const [mail] = platform.mails;
  assert.ok(mail);
  assert.equal(mail.subject.length, 200);
  assert.ok(mail.body.length <= 10_000);
  assert.match(mail.body, /Outcome: recorded/u, 'the outcome line survives a huge vendor');
  assert.match(mail.body, /Amount: /u);
  assert.doesNotMatch(mail.body, /[\uD800-\uDBFF]$/u, 'no lone surrogate at a cut');
});

/** The platform's pre-transport refusals, in the problem shape its `createProblem` writes. */
const CERTAIN_REFUSALS: ProblemInput[] = [
  {
    status: 403,
    code: 'FORBIDDEN',
    detail: 'The recipient is an address inside the requesting workspace',
    details: { reason: 'recipient_inside_workspace' },
  },
  {
    status: 502,
    code: 'DEPENDENCY_FAILURE',
    detail:
      'The workspace membership could not be fully resolved, so the recipient cannot be verified',
    details: { reason: 'workspace_membership_truncated' },
  },
  {
    status: 503,
    code: 'NOT_CONFIGURED',
    detail: 'outbound_mail is not configured',
    details: { component: 'outbound_mail' },
  },
];

test('a refusal the platform decided before sending is reported as certain', async () => {
  for (const problem of CERTAIN_REFUSALS) {
    const label = `${problem.status} ${String(problem.details?.reason ?? '')}`;
    const platform = new RecordingPlatform();
    platform.mail = () => Promise.reject(refusalFixture('mail', problem));
    const result = await automation.execute(invokeAt(3), platform);
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.equal(notify?.outcome, 'failed', label);
    assert.doesNotMatch(notify?.summary ?? '', /may have been sent/u, label);
    assert.equal(output(result).notified, false, `${label} is a certain failure`);
  }
});

test("a refused notify's summary names the platform's reason or status, never the envelope or the address", async () => {
  const address = 'private.person@example.com';
  const cases: [ProblemInput, RegExp][] = [
    [
      {
        status: 400,
        code: 'BAD_REQUEST',
        detail: `to must be a single mailbox address, not ${address}`,
        details: { field: 'to' },
      },
      /could not be emailed: the platform refused it \(HTTP 400\)$/u,
    ],
    [
      CERTAIN_REFUSALS[0]!,
      /could not be emailed: the platform refused it \(recipient_inside_workspace\)$/u,
    ],
  ];
  for (const [problem, expected] of cases) {
    const platform = new RecordingPlatform();
    platform.mail = () => Promise.reject(refusalFixture('mail', problem));
    await automation.execute(invokeAt(3, { notifyEmail: address }), platform);
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.ok(notify);
    assert.match(notify.summary, expected);
    assert.doesNotMatch(
      notify.summary,
      /urn:autom8x|refused with|private\.person|[{}"]/u,
      'the envelope and the address stay out of the timeline',
    );
  }
});

test('an outcome the platform never reported leaves `notified` absent, not false', async () => {
  const reset = new TypeError('fetch failed');
  const timeout = new Error('signal timed out');
  timeout.name = 'TimeoutError';
  for (const error of [
    reset,
    timeout,
    // The Edge's own 502 when Runs is unreachable, and a hop's empty 504: no reason either way.
    refusalFixture('mail', {
      status: 502,
      code: 'DEPENDENCY_FAILURE',
      detail: 'Runs service is unreachable',
    }),
    refusalFixture('mail', { status: 504, code: 'DEPENDENCY_FAILURE', detail: 'Gateway Timeout' }),
  ]) {
    const platform = new RecordingPlatform();
    platform.mail = () => Promise.reject(error);
    const result = await automation.execute(invokeAt(3), platform);
    const notify = platform.steps.find((step) => step.stepId === 'notify');
    assert.equal(notify?.outcome, 'failed', error.message);
    assert.match(notify?.summary ?? '', /may have been sent/u, error.message);
    assert.ok(
      !('notified' in output(result)),
      `${error.message}: an unknown outcome must not claim notified: false`,
    );
  }
});

test('the manifests moved here are the platform’s: v2 declares the Gmail scope nothing here spends, v3 and v4 declare none', () => {
  for (const version of [1, 3, 4]) {
    const manifest = JSON.parse(
      readFileSync(join(manifestsRoot, `invoice-check.v${version}.json`), 'utf8'),
    ) as { requiredConnections: unknown[]; requiredCapabilities: unknown[] };
    assert.deepEqual(manifest.requiredConnections, [], `v${version}`);
    assert.deepEqual(manifest.requiredCapabilities, []);
  }
});
