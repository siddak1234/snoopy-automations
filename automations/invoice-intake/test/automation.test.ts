import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  idempotencyKeyFor,
  readManifests,
  type InvokeRequest,
  type RunResult,
} from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  declaredSteps,
  invokeFixture,
  refusalFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';

const manifestsRoot = resolve(import.meta.dirname, '../../../manifests');
const manifests = readManifests(manifestsRoot, TEMPLATE_ID);
const automation = define(manifests);

function invoke(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    config: { holdAboveAmount: 500, notifyEmail: 'ap@example.com' },
    input: {
      trigger: { kind: 'webhook', deliveryId: 'delivery-1001' },
      payload: { vendor: 'Northwind Trading', amount: 120.5, reference: 'INV-1001' },
    },
    ...overrides,
  });
}

function successOutput(result: RunResult): Record<string, unknown> {
  assert.equal(result.outcome, 'success');
  assert.ok(result.outcome === 'success');
  return result.output ?? {};
}

test('the container serves every version in manifests/ with one pipeline', () => {
  assert.deepEqual(automation.versions, [1, 2, 3]);
  assert.deepEqual(automation.steps, ['receive', 'validate', 'notify']);
  assert.deepEqual(automation.prompts, []);
});

test('a webhook invoice within threshold is accepted and the vendor is told through the platform', async () => {
  for (const templateVersion of automation.versions) {
    const platform = new RecordingPlatform();
    const request = invoke({ templateVersion });
    const result = await automation.execute(request, platform);

    assert.deepEqual(
      platform.steps.map((step) => [step.stepId, step.outcome]),
      [
        ['receive', 'ok'],
        ['validate', 'ok'],
        ['notify', 'ok'],
      ],
      `v${templateVersion}`,
    );
    assert.equal(platform.providerCalls.length, 0, 'no provider, no grant, no mailbox named here');
    assert.equal(platform.modelCalls.length, 0, 'invoice intake has no model callback');
    assert.equal(platform.mails.length, 1);
    const [mail] = platform.mails;
    assert.equal(mail?.to, 'ap@example.com');
    assert.equal(mail?.subject, 'Invoice INV-1001 — $120.50 automatically, within threshold');
    assert.equal(
      mail?.body,
      'Invoice INV-1001 from Northwind Trading\nAmount: $120.50\nOutcome: accepted automatically, within threshold',
    );
    assert.equal(mail?.idempotencyKey, idempotencyKeyFor(request.runId, 'notify'));
    assert.deepEqual(successOutput(result), {
      reference: 'INV-1001',
      vendor: 'Northwind Trading',
      amount: 120.5,
      decidedBy: 'automatically, within threshold',
      notified: true,
    });
    assert.ok(result.outcome === 'success');
    assert.equal(result.summary, 'Accepted invoice INV-1001 automatically, within threshold');
  }
});

test('the mail key is one per run and step, stable on a re-run, inside the platform bound', async () => {
  const request = invoke({ runId: 'run'.repeat(100) });
  const first = new RecordingPlatform();
  const replay = new RecordingPlatform();
  await automation.execute(request, first);
  await automation.execute(request, replay);
  const key = first.mails[0]?.idempotencyKey;
  assert.ok(key);
  assert.equal(key, replay.mails[0]?.idempotencyKey);
  assert.match(key, /^notify-[0-9a-f]{48}$/u);
  assert.ok(key.length >= 16 && key.length <= 128);
});

test('an invoice above threshold ends held and an approval resumes at notify from state alone', async () => {
  const platform = new RecordingPlatform();
  const heldResult = await automation.execute(
    invoke({
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-2002' },
        payload: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
      },
    }),
    platform,
  );

  assert.equal(heldResult.outcome, 'held');
  assert.ok(heldResult.outcome === 'held');
  assert.equal(heldResult.held.stepId, 'validate');
  assert.equal(heldResult.held.reason, 'Contoso — $1499.99, above the $500.00 threshold');
  assert.deepEqual(heldResult.held.state, {
    invoice: { vendor: 'Contoso', amount: 1499.99, reference: 'INV-2002' },
  });
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.outcome]),
    [
      ['receive', 'ok'],
      ['validate', 'held'],
    ],
  );
  assert.equal(
    platform.steps[1]?.heldReason,
    'Someone should approve this invoice before its intake notice is sent',
  );
  assert.equal(platform.mails.length, 0, 'a held run stops before the side effect');

  const resumed = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      runId: 'aaaaaaaa-0000-4000-8000-000000000002',
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        decidedAt: '2026-10-08T18:00:00.000Z',
        state: heldResult.held.state,
      },
    }),
    resumed,
  );

  assert.deepEqual(
    resumed.steps.map((step) => step.stepId),
    ['notify'],
    'the continuation performs only the work that remains',
  );
  assert.equal(successOutput(result).decidedBy, 'after approval');
  assert.equal(successOutput(result).notified, true);
  assert.equal(resumed.mails.length, 1);
  assert.match(resumed.mails[0]?.subject ?? '', /after approval$/u);
  assert.equal(resumed.providerCalls.length, 0);
  assert.equal(resumed.modelCalls.length, 0);
});

test('a continuation whose state carries no invoice fails rather than inventing one', async () => {
  const platform = new RecordingPlatform();
  const result = await automation.execute(
    invoke({
      input: {},
      continuation: {
        ofRunId: invoke().runId,
        kind: 'approval',
        stepId: 'validate',
        decision: 'approved',
        state: { invoice: { vendor: 'Contoso' } },
      },
    }),
    platform,
  );
  assert.deepEqual(result, {
    outcome: 'failed',
    failureReason: 'the approved state did not carry an invoice',
  });
  assert.equal(platform.mails.length, 0);
});

test('a direct or malformed payload is refused rather than invented into an invoice', async () => {
  for (const input of [
    { vendor: 'Contoso', amount: 10, reference: 'DIRECT-1' },
    { trigger: { kind: 'manual' }, payload: { vendor: 'Contoso', amount: 10, reference: 'M-1' } },
    { trigger: { kind: 'webhook' }, payload: { vendor: 'Contoso' } },
    { trigger: { kind: 'webhook' }, payload: { vendor: 'Contoso', amount: -1, reference: 'N-1' } },
  ]) {
    const platform = new RecordingPlatform();
    const result = await automation.execute(invoke({ input }), platform);
    assert.deepEqual(result, {
      outcome: 'failed',
      failureReason: 'webhook payload must carry vendor, amount, and reference',
    });
    assert.deepEqual(
      platform.steps.map((step) => [step.stepId, step.outcome]),
      [['receive', 'failed']],
    );
    assert.equal(platform.mails.length, 0);
  }
});

test('a notice the platform refused or never answered is visible without undoing the accepted invoice', async () => {
  const privateMarker = 'private-provider-response@example.com';
  // Each refusal in the problem shape the platform's `createProblem` writes and the
  // Edge relays; the marker rides in `detail` and `details` to prove neither reaches
  // a summary or the result.
  const cases: [() => Promise<void>, RegExp][] = [
    [
      () =>
        Promise.reject(
          refusalFixture('mail', {
            status: 403,
            code: 'FORBIDDEN',
            detail: `The recipient is an address inside the requesting workspace: ${privateMarker}`,
            details: { reason: 'recipient_inside_workspace', to: privateMarker },
          }),
        ),
      /^The platform refused the intake notice: recipient_inside_workspace$/u,
    ],
    [
      () =>
        Promise.reject(
          refusalFixture('mail', {
            status: 400,
            code: 'BAD_REQUEST',
            detail: `to must be a mailbox ${privateMarker}`,
            details: { field: 'to' },
          }),
        ),
      /^The platform refused the intake notice$/u,
    ],
    [
      () =>
        Promise.reject(
          refusalFixture('mail', {
            status: 502,
            code: 'DEPENDENCY_FAILURE',
            detail: 'Runs service is unreachable',
          }),
        ),
      /may have been sent — do not re-send by hand$/u,
    ],
    [() => Promise.reject(new TypeError(privateMarker)), /may have been sent/u],
  ];
  for (const [mail, summary] of cases) {
    const platform = new RecordingPlatform();
    platform.mail = mail;
    const result = await automation.execute(invoke(), platform);

    assert.equal(result.outcome, 'success');
    assert.equal(successOutput(result).notified, false);
    assert.equal(platform.steps.at(-1)?.stepId, 'notify');
    assert.equal(platform.steps.at(-1)?.outcome, 'failed');
    assert.match(platform.steps.at(-1)?.summary ?? '', summary);
    assert.ok(!JSON.stringify(platform.steps).includes(privateMarker));
    assert.ok(!JSON.stringify(result).includes(privateMarker));
  }

  const unconfigured = new RecordingPlatform();
  const result = await automation.execute(
    invoke({ config: { holdAboveAmount: 500 } }),
    unconfigured,
  );
  assert.equal(successOutput(result).notified, false);
  assert.equal(unconfigured.mails.length, 0);
  assert.equal(unconfigured.steps.at(-1)?.summary, 'The notification address is not configured');
});

test('the address and unrelated webhook fields never enter retained summaries, and the subject stays one line', async () => {
  const marker = 'ACCOUNT-9911-ROUTING-2200';
  const platform = new RecordingPlatform();
  await automation.execute(
    invoke({
      config: { holdAboveAmount: 500, notifyEmail: 'private.person@example.com' },
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-private' },
        payload: { vendor: 'Contoso', amount: 10, reference: 'INV-PRIVATE', routing: marker },
      },
    }),
    platform,
  );
  const summaries = platform.steps.map((step) => step.summary).join(' | ');
  assert.ok(!summaries.includes(marker), 'an unrelated payload field leaked');
  assert.ok(!summaries.includes('private.person@example.com'), 'the configured address leaked');

  // A reference with a line break is refused at receive (control characters), so
  // nothing a webhook carries can reach a header; the subject is bounded anyway.
  const injected = new RecordingPlatform();
  const refused = await automation.execute(
    invoke({
      input: {
        trigger: { kind: 'webhook', deliveryId: 'd' },
        payload: {
          vendor: 'Contoso',
          amount: 10,
          reference: 'INV-9\r\nBcc: attacker@evil.example',
        },
      },
    }),
    injected,
  );
  assert.equal(refused.outcome, 'failed');
  assert.equal(injected.mails.length, 0);
  for (const mail of platform.mails) {
    assert.doesNotMatch(mail.subject, /[\r\n]/u);
    assert.ok(mail.subject.length <= 200);
  }
});

test('every possible step is declared by every served version, and no served version asks for a Google scope the code could spend', async () => {
  const scenarios = [
    invoke(),
    invoke({
      input: {
        trigger: { kind: 'webhook', deliveryId: 'delivery-held' },
        payload: { vendor: 'Contoso', amount: 9999, reference: 'INV-HELD' },
      },
    }),
    invoke({ input: {} }),
  ];
  for (const manifest of manifests) {
    const declared = declaredSteps(join(manifestsRoot, `${TEMPLATE_ID}.v${manifest.version}.json`));
    for (const scenario of scenarios) {
      const platform = new RecordingPlatform();
      await automation.execute({ ...scenario, templateVersion: manifest.version }, platform);
      for (const step of platform.steps) {
        assert.ok(
          declared.has(step.stepId),
          `v${manifest.version}: undeclared step ${step.stepId}`,
        );
      }
    }
    assert.deepEqual(manifest.requiredCapabilities, []);
  }

  // v1 still declares `gmail.send` (a registered version is immutable); v2 and v3
  // declare no connection. The code calls no provider on any version, so the v1
  // grant is never spent — platform ADR-0021.
  for (const version of [2, 3]) {
    const manifest = JSON.parse(
      readFileSync(join(manifestsRoot, `${TEMPLATE_ID}.v${version}.json`), 'utf8'),
    ) as { requiredConnections: unknown[] };
    assert.deepEqual(manifest.requiredConnections, [], `v${version} declares no connection`);
  }
});
