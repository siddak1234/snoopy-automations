import { test } from 'node:test';

import { invokeFixture } from '../src/testing.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * The review of each change and the several-choice dropdown against the platform's PUBLISHED
 * schemas (`contract/schemas`). These fail until `contract/` is re-pinned to the platform's `main`
 * after its round for ICD-10 Code Check merges (the land step): the schemas vendored today carry
 * neither `held.decisions`, `continuation.decisions` nor the `select` setup control.
 */

test('a held result with decisions is one the platform accepts', () => {
  assertValid(
    validator('automation-run-result'),
    {
      runId: '11111111-1111-4111-8111-111111111111',
      outcome: 'held',
      held: {
        stepId: 'decide',
        reason: '2 changes need your review.',
        state: { n: 2 },
        decisions: [
          { id: 'change-1', label: 'N18.4 → Remove', detail: 'From the note: “ESRD.”' },
          { id: 'change-2', label: 'Add Z99.2' },
        ],
      },
    },
    'a held result offering changes',
  );
});

test('a continuation carrying a review is one the platform sends', () => {
  assertValid(
    validator('automation-invoke-request'),
    invokeFixture({
      continuation: {
        ofRunId: '44444444-4444-4444-8444-444444444444',
        kind: 'approval',
        stepId: 'decide',
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        state: {},
        decisions: [
          { id: 'change-1', decision: 'accepted' },
          { id: 'change-2', decision: 'denied' },
        ],
      },
    }),
    'a continuation with decisions',
  );
});
