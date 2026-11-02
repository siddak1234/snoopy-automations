import type { JsonObject } from './contract.js';
import { type CallbackRefusedError, refusalFrom } from './refusals.js';

/**
 * The platform's refusals as test fixtures, split from `testing.ts` for the line ceiling and
 * exported from `@autom8x/automation-sdk/testing` with it.
 */

/** A refusal as the platform's handlers raise it: a status, a code, a sentence, and the typed `details`. */
export interface ProblemInput {
  status: number;
  code: string;
  detail: string;
  details?: JsonObject;
  requestId?: string;
}

/** The problem codes the platform names and their titles — `titleFor` in its `packages/http`. */
const PROBLEM_TITLES: Readonly<Record<string, string>> = {
  BAD_REQUEST: 'Bad Request',
  PAYLOAD_TOO_LARGE: 'Payload Too Large',
  UNAUTHENTICATED: 'Authentication Required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not Found',
  CONFLICT: 'Conflict',
  NOT_CONFIGURED: 'Service Not Configured',
  TOO_MANY_REQUESTS: 'Too Many Requests',
  DEPENDENCY_FAILURE: 'Dependency Failure',
  INTERNAL_ERROR: 'Internal Server Error',
};

/**
 * A refusal body exactly as the platform's `createProblem` writes it and the Edge
 * relays it: RFC 7807, `details` at the top level, no `error` wrapper. Longer than
 * the 200 characters `CallbackRefusedError.detail` keeps — which is the point: a
 * fixture in this shape fails any reader that parses the cut instead of the body.
 */
export function problemFixture(input: ProblemInput): JsonObject {
  const requestId = input.requestId ?? '55555555-5555-4555-8555-555555555555';
  return {
    type: `urn:autom8x:problem:${input.code.toLowerCase().replaceAll('_', '-')}`,
    title: PROBLEM_TITLES[input.code] ?? input.code,
    status: input.status,
    detail: input.detail,
    instance: `urn:autom8x:request:${requestId}`,
    code: input.code,
    requestId,
    ...(input.details ? { details: input.details } : {}),
  };
}

/**
 * The error the client throws when `callback` answers this problem — built by the
 * same function the client uses, so a `ModelRefusedError` for a typed model
 * refusal and a `CallbackRefusedError` for anything else. Hand it to
 * `RecordingPlatform.mail`, `.model` or `.provider` to rehearse a refusal.
 */
export function refusalFixture(callback: string, problem: ProblemInput): CallbackRefusedError {
  return refusalFrom(callback, problem.status, JSON.stringify(problemFixture(problem)));
}
