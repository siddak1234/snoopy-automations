import { beforeEach } from 'node:test';

import { unanswered } from '../src/marks.js';
import { retryClock } from '../src/retry.js';
import type { AutomationDefinition, Step } from '../src/steps.js';
import { define, ok } from './runner-fixtures.js';

/** What the retry suites share: a failure with no answer, a posting step, and the waits. */

/** An answer that never came, marked as the client marks fetch's own rejection. */
export async function noAnswer(message = 'fetch failed'): Promise<TypeError> {
  const error = new TypeError(message);
  await unanswered(Promise.reject(error)).catch(() => undefined);
  return error;
}

export const posting: Step = async ({ platform }) => {
  const answer = await platform.callProvider({
    providerId: 'example-provider',
    operation: 'records.create',
    input: { reference: 'INV-7' },
  });
  return { outcome: 'ok', summary: `Posted with ${answer.status}` };
};

export function retrying(retry?: AutomationDefinition['retry'], post: Step = posting) {
  return define({
    steps: { receive: ok('Received'), validate: ok('Validated'), post },
    ...(retry ? { retry } : {}),
  });
}

/**
 * Every policy in these suites waits at least the floor. Called once at the top
 * of a suite, this records each wait the runner asks for instead of sleeping it,
 * so a retry costs no real time and the waits themselves are asserted; the list
 * is emptied before every test.
 */
export function recordedWaits(): number[] {
  const waited: number[] = [];
  retryClock.sleep = (milliseconds) => {
    waited.push(milliseconds);
    return Promise.resolve();
  };
  beforeEach(() => {
    waited.length = 0;
  });
  return waited;
}
