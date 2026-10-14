import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject, StepResult } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { runResult } from '../src/output.js';
import { NOT_RECORDED } from '../src/quickbooks-path.js';
import { saveDetails } from '../src/steps/save-details.js';
import { NONE_PATH, bill, check, documentOf, receipt, statement } from './check-world.js';
import { NONE, QUICKBOOKS } from './fixtures.js';
import { assertOutputValid } from './output-schema.js';

/**
 * The run's result when the details are saved (`src/output.ts`, `src/steps/save-details.ts`;
 * v2's §2.8 and §3.F): the vendor "None", or QuickBooks not recording the document after all —
 * one of its rules, or QuickBooks failing mid-run (decision 6). Its result line in the spec's
 * words, its details, and an output the manifest's outputSchema describes.
 */

const FIRST = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 2, config: QUICKBOOKS });

/** The state save-details leaves, from a first read on the given path and what became of QuickBooks. */
async function savedState(answer: JsonObject, quickBooks?: JsonObject): Promise<JsonObject> {
  const path = quickBooks === undefined ? NONE_PATH : {};
  const document = documentOf(check(answer, path));
  const request = invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 2,
    config: quickBooks === undefined ? NONE : QUICKBOOKS,
  });
  const state: JsonObject = {
    document: document as unknown as JsonObject,
    ...(quickBooks === undefined ? {} : { quickBooks }),
  };
  const result = (await saveDetails({
    request,
    state,
    platform: new RecordingPlatform(),
    attempt: 1,
  } as never)) as Extract<StepResult, { outcome: 'ok' }>;
  assert.equal(result.outcome, 'ok');
  assert.ok(result.state);
  return result.state;
}

test('the vendor "None": the details saved — the result line, the details, and an output with no QuickBooks reason', async () => {
  const result = runResult(await savedState(bill()), FIRST);
  assert.equal(result.summary, 'Saved: Harrowgate Office Supply, $413.34.');
  assert.deepEqual(result.details, [
    { label: 'Type', value: 'Bill' },
    { label: 'Seller', value: 'Harrowgate Office Supply' },
    { label: 'Number', value: 'HOS-1042' },
    { label: 'Date', value: 'Sep 14, 2026' },
    { label: 'Due', value: 'Oct 14, 2026' },
    { label: 'Total', value: '$413.34' },
    { label: 'Tax', value: '$30.59' },
    { label: 'Category', value: 'Office supplies' },
  ]);
  assert.deepEqual(result.mail, {
    kind: 'saved',
    seller: 'Harrowgate Office Supply',
    total: '$413.34',
  });
  assert.equal(result.output.outcome, 'saved');
  assert.equal(result.output.notRecorded, null);
  assertOutputValid(result.output);
  // A receipt paid by card says the card's last four digits; a statement has no category.
  const paid = runResult(await savedState(receipt()), FIRST).details;
  assert.ok(paid.some((line) => line.label === 'Paid with' && line.value === 'Card ending 4417'));
  const listed = runResult(await savedState(statement()), FIRST);
  assert.equal(listed.output.documentType, 'supplier_statement');
  assert.ok(!listed.details.some((line) => ['Category', 'Paid with'].includes(line.label)));
  assertOutputValid(listed.output);
});

test('QuickBooks chosen, not recorded: "Saved. Not recorded in QuickBooks: {reason}." — or, for a write it may have made, "didn\'t confirm"', async () => {
  const notRecorded = runResult(
    await savedState(bill(), { notRecorded: NOT_RECORDED.closed_books }),
    FIRST,
  );
  assert.equal(
    notRecorded.summary,
    'Saved. Not recorded in QuickBooks: that date is in closed books.',
  );
  assert.deepEqual(notRecorded.details.at(-1), {
    label: 'QuickBooks',
    value: 'Not recorded: that date is in closed books',
  });
  assert.equal(notRecorded.output.notRecorded, 'that date is in closed books');
  assertOutputValid(notRecorded.output);
  const unconfirmed = runResult(await savedState(bill(), { unconfirmed: true }), FIRST);
  assert.equal(
    unconfirmed.summary,
    "Saved. QuickBooks didn't confirm. Check QuickBooks before you run it again.",
  );
  assert.deepEqual(unconfirmed.details.at(-1), { label: 'QuickBooks', value: "Didn't confirm" });
  assertOutputValid(unconfirmed.output);
});
