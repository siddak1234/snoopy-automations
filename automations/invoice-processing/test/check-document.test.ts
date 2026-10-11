import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineAutomation, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { CHECK_DOCUMENT_SENTENCES } from '../src/checks/rules.js';
import { FIND_PAYER_SENTENCES } from '../src/steps/find-payer.js';
import {
  CHECK_DOCUMENT_GUARDS,
  checkDocument,
  checkedSummary,
} from '../src/steps/check-document.js';
import {
  PAYERS,
  bill,
  check,
  creditNote,
  documentOf,
  receipt,
  sampleAnswer,
  statement,
} from './check-world.js';
import { SEEDED_STATE } from './extract-world.js';
import { FILE_ID, lines, reads, setUp } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';
import { SAMPLE_ROUTES } from './sample-routes.js';

/**
 * `check-document` as a step on the SDK's runner: what it keeps and drops of the state, its
 * timeline line, its guards, the run's clock, and every made-up sample's expected answer routed as
 * the plan says.
 */

const VISA_ACCOUNTS = {
  ...(SEEDED_STATE.accounts as JsonObject),
  paidFrom: { id: '41', fullyQualifiedName: 'Company Visa', accountType: 'Credit Card' },
};

/** check-document alone: a first step seeds the state the steps before it leave. */
function world(
  seeded: JsonObject,
  input: JsonObject = {},
  now = Date.parse('2026-10-11T12:00:00Z'),
) {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 1,
        requiredCapabilities: [],
        pipeline: [{ id: 'seed' }, { id: 'check-document' }],
      },
    ],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      'check-document': checkDocument({ now: () => now }),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  const request = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1, input });
  return { platform, run: () => automation.execute(request, platform) };
}

const seeded = (answer: unknown, more: JsonObject = {}): JsonObject => ({
  ...SEEDED_STATE,
  accounts: VISA_ACCOUNTS,
  extraction: answer as JsonObject,
  modelServed: 'anthropic/claude-haiku-4.5',
  ...more,
});

test('the raw answer leaves the state; every earlier key stays, and the cleaned document joins them', async () => {
  const { platform, run } = world(seeded(bill()));
  const result = await run();
  assert.ok(result.outcome === 'success');
  const { extraction, document, ...rest } = result.output ?? {};
  assert.equal(extraction, undefined, 'the answer, its lines and their words, gone');
  const { extraction: _answer, ...earlier } = seeded(bill());
  assert.deepEqual(rest, earlier);
  assert.deepEqual(document, documentOf(check(bill())));
  assert.deepEqual(
    [platform.providerCalls, platform.modelCalls, platform.mails],
    [[], [], []],
    'no call of any kind',
  );
  assert.deepEqual(lines(platform).at(-1), [
    'check-document',
    'ok',
    'Checks passed: a bill, $413.34, dated 2026-09-14, due 2026-10-14, HOS-1042, Harrowgate Office Supply',
  ]);
});

test('a fail rule ends the run with its sentence, and the timeline says the rule word', async () => {
  const { platform, run } = world(seeded(receipt({ cashBackPrinted: true })));
  assert.deepEqual(await run(), { outcome: 'failed', failureReason: CHECK_DOCUMENT_SENTENCES.C16 });
  assert.deepEqual(lines(platform).at(-1), [
    'check-document',
    'failed',
    'Checked, not recorded (cash_back)',
  ]);
});

test('the guards that should never fire: an answer that is not the schema, a record missing', async () => {
  const unusable = world(seeded({ documentType: 'bill' }));
  assert.deepEqual(await unusable.run(), {
    outcome: 'failed',
    failureReason:
      'The document could not be read. Try a clearer photo or the PDF. Nothing was created.',
  });
  const missing = [
    { company: undefined },
    { company: { legalName: null } },
    { accounts: undefined },
  ];
  for (const more of missing) {
    const run = world(seeded(bill(), more));
    assert.deepEqual(
      await run.run(),
      { outcome: 'failed', failureReason: CHECK_DOCUMENT_GUARDS.state_incomplete },
      JSON.stringify(more),
    );
  }
  // The switch on, and no payer kept: never a silent company record.
  const noPayer = world(seeded(bill()), { paidPersonally: true, paidBy: 'Sam Lee' });
  assert.deepEqual(await noPayer.run(), {
    outcome: 'failed',
    failureReason:
      'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
  });
});

test("the run's clock: a document dated tomorrow passes, two days ahead fails, by the UTC date", async () => {
  const dated = (date: string) => seeded(bill({ documentDate: date, dueDate: null }));
  const late = Date.parse('2026-10-10T23:59:00Z');
  const early = Date.parse('2026-10-11T00:01:00Z');
  assert.equal((await world(dated('2026-10-11'), {}, late).run()).outcome, 'success');
  assert.deepEqual(await world(dated('2026-10-12'), {}, late).run(), {
    outcome: 'failed',
    failureReason: CHECK_DOCUMENT_SENTENCES.C23,
  });
  assert.equal((await world(dated('2026-10-12'), {}, early).run()).outcome, 'success');
});

test('the same state and clock give the same answer: a run re-sent reaches it again', async () => {
  const first = await world(seeded(sampleAnswer('restaurant-tip-under-total'))).run();
  const second = await world(seeded(sampleAnswer('restaurant-tip-under-total'))).run();
  assert.deepEqual(first, second);
});

test('the line: what was found first, then what it is, amount, dates, number cut to 30, the seller last and cut', () => {
  const under = documentOf(check(sampleAnswer('restaurant-tip-under-total')));
  assert.equal(
    checkedSummary(under, false),
    'Tip of $6.00 added to the printed total: a receipt, $38.48, dated 2026-09-23, 7713, Saltmarsh Lane Diner',
  );
  const many = documentOf(
    check(
      bill({
        vendorName: 'V'.repeat(500),
        documentNumber: 'N'.repeat(40),
        currency: 'XYZ',
        dueDate: null,
        paymentTermsDays: null,
        total: 999,
        uncertainFields: ['total', 'documentDate', 'vendorName'],
      }),
    ),
  );
  const line = checkedSummary(many, false);
  assert.equal(line.length, 200);
  assert.ok(
    line.startsWith(
      "Amounts don't add up; unclear: total, seller +1; currency not recognised: a bill, $999.00, dated 2026-09-14, no due date, NNNN",
    ),
    line,
  );
  assert.ok(line.endsWith('…'));
  assert.ok(line.includes(`${'N'.repeat(29)}…, VVV`), 'the number cut to 30');
  assert.equal(
    checkedSummary(documentOf(check(statement())), false),
    'Checks passed: a supplier statement, balance $686.54, dated 2026-09-30, 6 rows that add up, ST-2609-118, Harrowgate Office Supply',
  );
  assert.equal(
    checkedSummary(documentOf(check(creditNote())), false),
    'Checks passed: a credit note, $203.20, dated 2026-09-22, CM-0077, Harrowgate Office Supply',
  );
  assert.equal(
    checkedSummary(documentOf(check(receipt(), { switchOn: true, payer: PAYERS.employee })), true),
    'Checks passed: a receipt paid personally, $60.63, dated 2026-09-27, 55120, Tidewell Hardware',
  );
});

test("every sample's expected answer, run through check-document, takes the route its expected.json names", () => {
  assert.deepEqual(
    Object.keys(SAMPLE_ROUTES),
    SAMPLES.map((sample) => sample.name),
  );
  for (const sample of SAMPLES) {
    const outcome = check(sample.answer);
    const [route, findings] = SAMPLE_ROUTES[sample.name]!;
    if (outcome.outcome === 'failed') {
      assert.equal(outcome.rule, route, sample.name);
      continue;
    }
    assert.equal(outcome.document.route, route, sample.name);
    assert.deepEqual(outcome.document.findings, findings, sample.name);
    const said = JSON.stringify([outcome.document, checkedSummary(outcome.document, false)]);
    assert.ok(
      !said.includes(sample.marker),
      `${sample.name}: the marker reached the state or line`,
    );
  }
});

test("a statement with the switch on and no 'Owed to team members' fails at find-payer (P3), before it is read", async () => {
  const run = setUp({
    input: { invoiceFile: FILE_ID, paidPersonally: true, paidBy: 'Robin Example' },
  });
  run.platform.model = reads(statement());
  assert.deepEqual(await run.run(), {
    outcome: 'failed',
    failureReason: FIND_PAYER_SENTENCES.team_owed_account_missing,
  });
  assert.deepEqual(run.platform.modelCalls, [], 'no read spent');
});

test('the fail rules in their order across the steps: A1 and P0–P4 before any read, C before F', async () => {
  // A bank statement uploaded with the switch on and no name: P1 at find-payer, nothing read.
  const unnamed = setUp({ input: { invoiceFile: FILE_ID, paidPersonally: true } });
  unnamed.platform.model = reads(bill({ documentType: 'bank_statement' }));
  assert.deepEqual(await unnamed.run(), {
    outcome: 'failed',
    failureReason: FIND_PAYER_SENTENCES.paid_by_missing,
  });
  assert.deepEqual(unnamed.platform.modelCalls, []);
  // A default category that resolves to nothing: A1 at find-accounts, nothing read.
  const unresolved = setUp({ config: { expenseAccount: 'No Such Account' } });
  assert.equal((await unresolved.run()).outcome, 'failed');
  assert.deepEqual(unresolved.platform.modelCalls, []);
  // Cash back on a receipt printed in euros: check-document's C16 before decide's F1, and no second read.
  const euros = setUp({
    config: { expenseAccount: 'Utilities:Electric', paidFromAccount: 'Company Visa' },
  });
  euros.platform.model = reads(receipt({ cashBackPrinted: true, currency: 'EUR' }));
  assert.deepEqual(await euros.run(), {
    outcome: 'failed',
    failureReason: CHECK_DOCUMENT_SENTENCES.C16,
  });
  assert.equal(
    euros.platform.modelCalls.length,
    1,
    'read 1 only: a document that fails is not read again',
  );
});
