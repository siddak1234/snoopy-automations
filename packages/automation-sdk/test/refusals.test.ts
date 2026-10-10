import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { PlatformClient } from '../src/platform.js';
import {
  CallbackRefusedError,
  MODEL_REFUSAL_REASONS,
  ModelRefusedError,
  mailCertainlyNotSent,
  problemOf,
} from '../src/refusals.js';
import { type ProblemInput, problemFixture, refusalFixture } from '../src/testing.js';
import { type StubPlatform, startStubPlatform } from './stub-platform.js';

/**
 * The platform's refusals as the client reads them, on the wire: an RFC 7807
 * problem with `details` at the top level and past the 200-character cut, the
 * typed model refusals, and the certain-versus-unknown line for mail. Every body
 * below is the shape the platform's `createProblem` writes and the Edge relays.
 */

const TOKEN = 'run-token-under-test';
let stub: StubPlatform;
let client: PlatformClient;

before(async () => {
  stub = await startStubPlatform();
});
after(async () => {
  await stub.close();
});
beforeEach(() => {
  stub.calls = [];
  stub.answers = {};
  stub.delayMs = 0;
  client = new PlatformClient(stub.origin, TOKEN, { timeoutMs: 1000, modelTimeoutMs: 1000 });
});

const mail = { to: 'v@example.com', subject: 's', body: 'b', idempotencyKey: 'k'.repeat(16) };
const model = {
  capability: 'document-extraction' as const,
  prompt: 'Extract.',
  input: { text: 'INV-1' },
  outputSchema: { type: 'object' },
};

/**
 * The platform's own 403 in the exact bytes `createProblem` emits (with a fixture
 * request id): what `ResendOutboundMail` refuses a recipient inside the workspace
 * with (its `apps/runs/src/outbound-mail.ts`), relayed as it is. 318 characters,
 * with the reason in the last 40 of them.
 */
const RECIPIENT_INSIDE_WORKSPACE =
  '{"type":"urn:autom8x:problem:forbidden","title":"Forbidden","status":403,"detail":"The recipient is an address inside the requesting workspace","instance":"urn:autom8x:request:7f3c0b4e-9a21-4d6e-8c1f-2b5a6d7e8f90","code":"FORBIDDEN","requestId":"7f3c0b4e-9a21-4d6e-8c1f-2b5a6d7e8f90","details":{"reason":"recipient_inside_workspace"}}';

test("a refusal's reason is read from the problem's top-level details, past the 200-character cut", async () => {
  assert.ok(RECIPIENT_INSIDE_WORKSPACE.length > 200);
  assert.ok(
    !RECIPIENT_INSIDE_WORKSPACE.slice(0, 200).includes('recipient_inside_workspace'),
    'the reason sits past the cut, so a reader of the cut never sees it',
  );
  stub.answers.mail = () => ({ status: 403, body: JSON.parse(RECIPIENT_INSIDE_WORKSPACE) });
  await assert.rejects(client.sendMail(mail), (error: unknown) => {
    assert.ok(error instanceof CallbackRefusedError);
    assert.equal(error.callback, 'mail');
    assert.equal(error.status, 403);
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.reason, 'recipient_inside_workspace');
    assert.deepEqual(error.details, { reason: 'recipient_inside_workspace' });
    assert.equal(error.detail.length, 200);
    assert.ok(!error.detail.includes('recipient_inside_workspace'));
    assert.ok(mailCertainlyNotSent(error));
    return true;
  });

  // The whole body, as the platform writes it; a `{ error: { … } }` wrapper is
  // tolerated for a hop that wraps what it relays, and never preferred to the
  // platform's own top-level `details`.
  assert.equal(problemOf(RECIPIENT_INSIDE_WORKSPACE).details.reason, 'recipient_inside_workspace');
  assert.equal(
    problemOf(JSON.stringify({ error: { code: 'FORBIDDEN', details: { reason: 'wrapped' } } }))
      .details.reason,
    'wrapped',
  );
  assert.equal(
    problemOf(JSON.stringify({ details: { reason: 'top' }, error: { details: { reason: 'in' } } }))
      .details.reason,
    'top',
  );
  assert.deepEqual(problemOf('not json'), { code: undefined, details: {} });
  assert.deepEqual(problemOf('[1]'), { code: undefined, details: {} });
  assert.deepEqual(problemOf(''), { code: undefined, details: {} });
});

test('a certain mail failure is told from an answer that never came, on the real problem shapes', async () => {
  const cases: [number, unknown, boolean, string][] = [
    [
      502,
      problemFixture({
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail:
          'The workspace membership could not be fully resolved, so the recipient cannot be verified',
        details: { reason: 'workspace_membership_truncated' },
      }),
      true,
      'the platform refused before the transport and released its reservation',
    ],
    [
      503,
      problemFixture({
        status: 503,
        code: 'NOT_CONFIGURED',
        detail: 'outbound_mail is not configured',
        details: { component: 'outbound_mail' },
      }),
      true,
      'nothing was attempted',
    ],
    [
      429,
      problemFixture({
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        detail: 'This run has sent its allowance of mail',
      }),
      true,
      'refused on the way in',
    ],
    [
      400,
      problemFixture({
        status: 400,
        code: 'BAD_REQUEST',
        detail: 'to must be a single mailbox address',
        details: { field: 'to' },
      }),
      true,
      'refused on the way in',
    ],
    [400, 'not a problem body', true, 'a 4xx is certain whatever the body'],
    [
      502,
      problemFixture({
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: 'Runs service is unreachable',
      }),
      false,
      "the Edge's own 502 names no reason: the platform may have sent",
    ],
    [504, '', false, 'a gateway timeout'],
  ];
  for (const [status, body, certain, why] of cases) {
    stub.answers.mail = () => ({ status, body });
    await assert.rejects(client.sendMail(mail), (error: unknown) => {
      assert.ok(error instanceof CallbackRefusedError);
      assert.equal(mailCertainlyNotSent(error), certain, `${status}: ${why}`);
      return true;
    });
  }
  assert.equal(mailCertainlyNotSent(new TypeError('fetch failed')), false, 'a dropped connection');
  const timeout = new Error('signal timed out');
  timeout.name = 'TimeoutError';
  assert.equal(mailCertainlyNotSent(timeout), false);
});

interface Typed {
  reason: string;
  path: string | undefined;
  rule: string | undefined;
  finishReason: string | undefined;
  used: number | undefined;
  limit: number | undefined;
}

function typedOf(error: ModelRefusedError): Typed {
  const { reason, path, rule, finishReason, used, limit } = error;
  return { reason, path, rule, finishReason, used, limit };
}

test('a model refusal the platform typed is a ModelRefusedError carrying its reason and fields, never the completion', async () => {
  const none = { path: undefined, rule: undefined, finishReason: undefined };
  const cases: [ProblemInput, Typed, RegExp][] = [
    [
      {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'The model completion does not match the request outputSchema',
        details: {
          reason: 'output_schema_mismatch',
          finishReason: 'stop',
          path: '$.total',
          rule: 'type:number',
        },
      },
      {
        reason: 'output_schema_mismatch',
        path: '$.total',
        rule: 'type:number',
        finishReason: 'stop',
        used: undefined,
        limit: undefined,
      },
      /^the model call was refused with 422: output_schema_mismatch at \$\.total \(type:number\)$/u,
    ],
    [
      {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'The model completion is not the JSON document the request declared',
        details: {
          reason: 'output_schema_mismatch',
          finishReason: 'stop',
          path: '$',
          rule: 'json',
        },
      },
      {
        reason: 'output_schema_mismatch',
        path: '$',
        rule: 'json',
        finishReason: 'stop',
        used: undefined,
        limit: undefined,
      },
      /output_schema_mismatch at \$ \(json\)$/u,
    ],
    [
      {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'The model provider declined to answer this request',
        details: { reason: 'content_filtered', finishReason: 'content_filter' },
      },
      {
        ...none,
        reason: 'content_filtered',
        finishReason: 'content_filter',
        used: undefined,
        limit: undefined,
      },
      /^the model call was refused with 422: content_filtered \(finish reason content_filter\)$/u,
    ],
    [
      {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'The model completion was truncated at the output budget',
        details: { reason: 'truncated', finishReason: 'length' },
      },
      { ...none, reason: 'truncated', finishReason: 'length', used: undefined, limit: undefined },
      /truncated \(finish reason length\)$/u,
    ],
    [
      {
        status: 403,
        code: 'FORBIDDEN',
        detail: "This workspace's plan does not allow another model call this month",
        details: { reason: 'over_plan_limit', used: 25, limit: 25 },
      },
      { ...none, reason: 'over_plan_limit', used: 25, limit: 25 },
      /^the model call was refused with 403: over_plan_limit \(25 of 25 this month\)$/u,
    ],
    [
      {
        status: 403,
        code: 'FORBIDDEN',
        detail: "This workspace's plan does not allow another model call this month",
        details: { reason: 'capability_not_in_plan', used: 0 },
      },
      { ...none, reason: 'capability_not_in_plan', used: 0, limit: undefined },
      /^the model call was refused with 403: capability_not_in_plan$/u,
    ],
    [
      {
        status: 403,
        code: 'FORBIDDEN',
        detail: "This workspace's plan does not allow another model call this month",
        details: { reason: 'entitlements_not_configured', used: 3 },
      },
      { ...none, reason: 'entitlements_not_configured', used: 3, limit: undefined },
      /entitlements_not_configured$/u,
    ],
    // The run's file (platform BUILD-PLAN 25.2.18): refused before anything was spent.
    [
      {
        status: 422,
        code: 'BAD_REQUEST',
        detail: "The run's file is a password-protected PDF",
        details: { reason: 'file_encrypted' },
      },
      { ...none, reason: 'file_encrypted', used: undefined, limit: undefined },
      /^the model call was refused with 422: file_encrypted$/u,
    ],
    [
      {
        status: 502,
        code: 'DEPENDENCY_FAILURE',
        detail: "The run's file is not the one the store measured",
        details: { reason: 'file_integrity' },
      },
      { ...none, reason: 'file_integrity', used: undefined, limit: undefined },
      /^the model call was refused with 502: file_integrity$/u,
    ],
  ];
  for (const [problem, typed, message] of cases) {
    stub.answers.model = () => ({ status: problem.status, body: problemFixture(problem) });
    await assert.rejects(client.callModel(model), (error: unknown) => {
      assert.ok(error instanceof ModelRefusedError, typed.reason);
      assert.ok(error instanceof CallbackRefusedError, 'still a refused callback');
      assert.equal(error.callback, 'model');
      assert.equal(error.status, problem.status);
      assert.equal(error.code, problem.code);
      assert.deepEqual(typedOf(error), typed);
      assert.match(error.message, message);
      // The testing entry builds the same error from the same answer.
      const twin = refusalFixture('model', problem);
      assert.ok(twin instanceof ModelRefusedError);
      assert.equal(twin.message, error.message);
      assert.deepEqual({ ...twin }, { ...error });
      return true;
    });
  }
  assert.deepEqual(
    [...MODEL_REFUSAL_REASONS].sort(),
    [
      'capability_not_in_plan',
      'content_filtered',
      'content_type_not_accepted',
      'entitlements_not_configured',
      'file_content_mismatch',
      'file_encrypted',
      'file_integrity',
      'file_too_large',
      'output_schema_mismatch',
      'over_plan_limit',
      'truncated',
    ],
    "the platform's eleven, and no other",
  );
});

test('a model refusal the platform did not type stays a plain CallbackRefusedError, with what it carries', async () => {
  // A schema the platform cannot hold a completion to: 400, no reason, the keyword in `detail`.
  stub.answers.model = () => ({
    status: 400,
    body: problemFixture({
      status: 400,
      code: 'BAD_REQUEST',
      detail:
        'outputSchema.properties.id uses pattern, which the platform cannot hold a completion to',
      details: { field: 'outputSchema.properties.id' },
    }),
  });
  await assert.rejects(client.callModel(model), (error: unknown) => {
    assert.ok(error instanceof CallbackRefusedError && !(error instanceof ModelRefusedError));
    assert.equal(error.reason, undefined);
    assert.deepEqual(error.details, { field: 'outputSchema.properties.id' });
    assert.match(error.detail, /uses pattern/u);
    return true;
  });
  // A capability the manifest never declared: 403 with a reason the runner refuses before the wire.
  stub.answers.model = () => ({
    status: 403,
    body: problemFixture({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'The automation did not declare that capability',
      details: { capability: 'document-extraction', reason: 'capability_not_declared' },
    }),
  });
  await assert.rejects(client.callModel(model), (error: unknown) => {
    assert.ok(error instanceof CallbackRefusedError && !(error instanceof ModelRefusedError));
    assert.equal(error.reason, 'capability_not_declared');
    return true;
  });
  // A count that is not one is dropped, not trusted; a body that is no problem types nothing.
  const odd = ModelRefusedError.from(
    403,
    JSON.stringify(
      problemFixture({
        status: 403,
        code: 'FORBIDDEN',
        detail: 'x',
        details: { reason: 'over_plan_limit', used: 'many', limit: -1 },
      }),
    ),
  );
  assert.ok(odd);
  assert.equal(odd.used, undefined);
  assert.equal(odd.limit, undefined);
  assert.equal(odd.message, 'the model call was refused with 403: over_plan_limit');
  assert.equal(ModelRefusedError.from(422, 'not json'), undefined);
  assert.equal(
    ModelRefusedError.from(422, '{"details":{"reason":"step_not_declared"}}'),
    undefined,
  );
});
