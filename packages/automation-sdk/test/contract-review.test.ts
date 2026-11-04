import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invokeFixture } from '../src/testing.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * The review of each change and the several-choice dropdown against the platform's PUBLISHED
 * schemas (`contract/schemas`, vendored at snoopy-backend 27c3051 (#255), PR #255's squash merge, which
 * carries `held.decisions`, `continuation.decisions` and the `select` setup control; a change's
 * `options` and an `other` answer since amendment 5, vendored at 7ae5d92).
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

test('amendment 5: a change offering options, and an answer picking one, are what the platform takes', () => {
  const result = validator('automation-run-result');
  const options = [
    { value: 'N18.32', label: 'N18.32 · Chronic kidney disease, stage 3b' },
    { value: 'N18.4', label: 'N18.4 · Chronic kidney disease, stage 4 (severe)' },
  ];
  const heldWith = (offered: unknown) => ({
    runId: '11111111-1111-4111-8111-111111111111',
    outcome: 'held',
    held: {
      stepId: 'decide',
      reason: '1 change needs your review.',
      state: {},
      decisions: [{ id: 'change-1', label: 'N18.30 → N18.31', options: offered }],
    },
  });
  assertValid(result, heldWith(options), 'a change with 2 options');
  assert.equal(result(heldWith([...options, ...options])), false, '4 options');
  assert.equal(result(heldWith([])), false, 'an empty list');
  assert.equal(result(heldWith([{ value: 'N18.32' }])), false, 'an option with no label');
  const invoke = validator('automation-invoke-request');
  const answered = (decisions: unknown[]) =>
    invokeFixture({
      continuation: {
        ofRunId: '44444444-4444-4444-8444-444444444444',
        kind: 'approval',
        stepId: 'decide',
        decision: 'approved',
        decidedAt: new Date().toISOString(),
        state: {},
        decisions: decisions as never,
      },
    });
  assertValid(invoke, answered([{ id: 'change-1', other: 'N18.32' }]), 'an other answer');
  assert.equal(
    invoke(answered([{ id: 'change-1', decision: 'accepted', other: 'N18.32' }])),
    false,
    'both a decision and an other',
  );
  assert.equal(invoke(answered([{ id: 'change-1', other: '' }])), false, 'an empty other');
});
