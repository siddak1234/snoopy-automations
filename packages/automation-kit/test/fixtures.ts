import type { ProviderRequest, StepPlatform } from '@autom8x/automation-sdk';
import { RecordingPlatform, refusalFixture } from '@autom8x/automation-sdk/testing';

import type { Clock } from '../src/quickbooks/read.js';
import { QuickBooksSimulator } from '../src/testing/quickbooks-simulator.js';

/** One step's key, as the SDK's runner derives it: the step id, then 48 hex characters. */
export const KEY = `read-company-${'0123456789abcdef'.repeat(3)}`;

/** A clock that records each wait and moves time on by it, so no test waits a minute. */
export function fakeClock(start = Date.parse('2026-10-10T16:00:00.000Z')) {
  let now = start;
  const waits: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
      return Promise.resolve();
    },
  };
  return {
    clock,
    waits,
    deadlineIn: (milliseconds: number) => new Date(now + milliseconds).toISOString(),
  };
}

/**
 * QuickBooks behind the platform, reached the way a step reaches it: through the SDK's
 * `RecordingPlatform`, with the step's one key attached to every call as the runner does.
 */
export function harness() {
  const simulator = new QuickBooksSimulator({ refusal: refusalFixture });
  const recording = new RecordingPlatform();
  recording.provider = simulator.provider;
  const platform: Pick<StepPlatform, 'callProvider'> = {
    callProvider: (request) => recording.callProvider({ ...request, idempotencyKey: KEY }),
  };
  return { simulator, recording, platform };
}

/** What a call to QuickBooks sent, without its key. */
export function sent(call: ProviderRequest): Omit<ProviderRequest, 'idempotencyKey'> {
  const { idempotencyKey: _key, ...request } = call;
  return request;
}
