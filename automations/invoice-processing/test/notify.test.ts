import assert from 'node:assert/strict';
import { test } from 'node:test';

import { idempotencyKeyFor, type JsonObject, type MailRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { PAID, type RouteRun } from './lookups-world.js';
import { approve, firstRun, outputOf } from './writes-world.js';

/**
 * notify (step 24; the plan's §5 "notify, per type"): one plain-text mail to the "Also email"
 * address — skipped, unreported, when it is empty — built from QuickBooks' answer, never the model's
 * words or a hold reason, with each path's next step; a statement's with its counts and what
 * QuickBooks shows open; a mail that fails never fails the run, and the step's line never carries
 * the address or the mail's words.
 */

const TO = 'books@example.com';
const withMail = (run: RouteRun, mail: JsonObject = { notifyEmail: TO }): RouteRun => ({
  ...run,
  config: { ...(run.config ?? PAID.company.config), ...mail },
});

/** The mail a whole run sent — approved, when it held — and the notify line. */
async function mailed(run: RouteRun) {
  const first = await firstRun(run);
  if (first.result.outcome === 'held') {
    const approved = await approve(first);
    return {
      result: approved.result,
      mails: approved.mails,
      line: approved.steps.find(([stepId]) => stepId === 'notify'),
      runId: approved.request.runId,
    };
  }
  return {
    result: first.result,
    mails: first.platform.mails,
    line: first.platform.steps
      .map((step) => [step.stepId, step.outcome, step.summary])
      .find(([stepId]) => stepId === 'notify'),
    runId: first.request.runId,
  };
}

test('no "Also email" address — none, empty, or spaces — no mail, no line, and the run succeeds', async () => {
  for (const mail of [{}, { notifyEmail: '' }, { notifyEmail: '   ' }, { notifyEmail: null }]) {
    const { result, mails, line } = await mailed(withMail({ answer: bill() }, mail));
    assert.equal(result.outcome, 'success');
    assert.deepEqual([mails, line], [[], undefined], JSON.stringify(mail));
  }
});

test("a bill's mail, straight through: QuickBooks' Id, vendor, number, date, total and due date, under notify's own key", async () => {
  const { mails, line, runId } = await mailed(withMail({ answer: bill() }));
  assert.deepEqual(mails, [
    {
      to: TO,
      subject: 'Bill 1001 recorded in QuickBooks: Harrowgate Office Supply, HOS-1042, $413.34',
      body: [
        'A bill was recorded in your QuickBooks Online company by Autom8x Bills & Receipts.',
        '',
        'Bill in QuickBooks: 1001',
        'Vendor: Harrowgate Office Supply',
        'Number: HOS-1042',
        'Date: 2026-09-14',
        'Total: $413.34',
        'Due date: 2026-10-14',
        'Category: Utilities:Electric',
        'Decided: automatically',
      ].join('\n'),
      idempotencyKey: idempotencyKeyFor(runId, 'notify'),
    },
  ]);
  assert.deepEqual(line, ['notify', 'ok', 'Emailed the summary to the "Also email" address']);
});

test("each path's mail says its next step; a receipt's, the bank rule that skips the review", async () => {
  const cases: [RouteRun, string[]][] = [
    [
      { answer: receipt() },
      [
        'An expense was recorded in your QuickBooks Online company by Autom8x Bills & Receipts.',
        '',
        'Expense in QuickBooks: 1001',
        'Vendor: Tidewell Hardware',
        'Number: 55120 (in the memo)',
        'Date: 2026-09-27',
        'Total: $60.63',
        'Paid from: Company Visa',
        'Category: Utilities:Electric',
        'Decided: automatically',
        '',
        'Next step: When this charge arrives in your bank feed, choose Match, not Add.',
        'A bank rule set to add matching charges automatically skips that review.',
      ],
    ],
    [
      { answer: receipt(), ...PAID.employee },
      [
        'A journal entry was recorded in your QuickBooks Online company by Autom8x Bills & Receipts.',
        '',
        'Journal entry in QuickBooks: 1001',
        'Seller: Tidewell Hardware',
        'Paid by: Robin Example',
        'Number: 55120 (in the memo)',
        'Date: 2026-09-27',
        'Total: $60.63',
        'Category: Utilities:Electric',
        'Decided: after approval',
        '',
        'Next step: Repay with a check or expense using Owed to Team Members as the category.',
      ],
    ],
  ];
  for (const [run, body] of cases) {
    const { mails } = await mailed(withMail(run));
    assert.equal(mails[0]?.body, body.join('\n'));
  }
  const next: [RouteRun, string, string][] = [
    [
      { answer: sampleAnswer('card-refund') },
      'Refund 1001 recorded in QuickBooks: Tidewell Hardware, R-6603, $23.72',
      'A bank rule set to add matching charges automatically skips that review.',
    ],
    [
      { answer: creditNote() },
      'Vendor credit 1001 recorded in QuickBooks: Harrowgate Office Supply, CM-0077, $203.20',
      'Decided: automatically',
    ],
    [
      { answer: receipt(), ...PAID.owner },
      'Journal entry 1001 recorded in QuickBooks: Tidewell Hardware, 55120, $60.63',
      'Next step: Categorise the repayment to Owner investments.',
    ],
    [
      { answer: receipt(), ...PAID.contractor },
      'Bill 1001 recorded in QuickBooks: Sam Lee, 55120, $60.63',
      'Next step: Pay it in Pay bills.',
    ],
  ];
  for (const [run, subject, last] of next) {
    const { mails } = await mailed(withMail(run));
    assert.equal(mails[0]?.subject, subject);
    assert.equal(mails[0]?.body.split('\n').at(-1), last, subject);
  }
  const { mails } = await mailed(withMail({ answer: sampleAnswer('card-refund') }));
  assert.ok(
    mails[0]?.body.includes(
      '\nNext step: When this charge arrives in your bank feed, choose Match, not Add.\n',
    ),
  );
});

test("a statement's mail: the counts and what QuickBooks shows open — never its own figures or invoice numbers", async () => {
  const { mails, result } = await mailed(withMail({ answer: statement() }));
  assert.equal(outputOf(result).outcome, 'compared');
  assert.deepEqual(
    mails.map(({ subject, body }) => ({ subject, body })),
    [
      {
        subject: 'Statement from Harrowgate Office Supply compared with QuickBooks',
        body: [
          "A supplier's statement was compared with your QuickBooks Online company by Autom8x Bills & Receipts. Nothing was recorded.",
          '',
          'Vendor: Harrowgate Office Supply',
          'Invoices it lists that are not in QuickBooks: 3',
          'Open bills in QuickBooks it does not list: 0',
          'QuickBooks shows open for this vendor: $980.00',
          '',
          "The statement's own figures and the invoice numbers are in the run's timeline in Autom8x.",
        ].join('\n'),
      },
    ],
  );
  for (const own of ['$686.54', 'HOS-1031', 'HOS-1050']) {
    assert.ok(!mails[0]?.body.includes(own), own);
  }
});

test("QuickBooks' answer wins over what was read: its total, due date and the vendor's name as it wrote them", async () => {
  const answer = {
    Bill: {
      Id: '151',
      DocNumber: 'HOS-1042',
      TxnDate: '2026-09-14',
      DueDate: '2026-10-15',
      TotalAmt: 413.35,
      VendorRef: { value: '7', name: 'Harrowgate Office Supply Co.' },
    },
    time: '2026-10-10T09:00:00.000-07:00',
  };
  const { mails, result } = await mailed(
    withMail({
      answer: bill(),
      company: (sim) => sim.script('bill.create', [{ status: 200, body: answer }]),
    }),
  );
  assert.equal(
    mails[0]?.subject,
    'Bill 151 recorded in QuickBooks: Harrowgate Office Supply Co., HOS-1042, $413.35',
  );
  assert.match(mails[0]?.body ?? '', /\nTotal: \$413\.35\nDue date: 2026-10-15\n/u);
  assert.equal(
    (result as { summary?: string }).summary,
    'Recorded bill 151 from Harrowgate Office Supply Co., HOS-1042, $413.34, due 2026-10-15; QuickBooks shows $413.35.',
  );
});

test('a mail refused for certain, or never answered, fails only its own line: the run succeeds, the record stands', async () => {
  const cases: [string, Error, string][] = [
    [
      'inside the workspace',
      refusalFixture('mail', {
        status: 403,
        code: 'FORBIDDEN',
        detail: 'x',
        details: { reason: 'recipient_inside_workspace' },
      }),
      'The summary was not emailed: the platform refused it (recipient_inside_workspace)',
    ],
    [
      'the daily cap',
      refusalFixture('mail', {
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        detail: 'x',
        details: { reason: 'per_workspace_daily_cap' },
      }),
      'The summary was not emailed: the platform refused it (per_workspace_daily_cap)',
    ],
    [
      'mail not configured',
      refusalFixture('mail', { status: 503, code: 'NOT_CONFIGURED', detail: 'x' }),
      'The summary was not emailed: the platform refused it (HTTP 503)',
    ],
    [
      'no answer',
      new TypeError('fetch failed'),
      'The summary may have been emailed: the platform did not answer. Do not re-send it by hand.',
    ],
    [
      'a reasonless 502',
      refusalFixture('mail', { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
      'The summary may have been emailed: the platform did not answer. Do not re-send it by hand.',
    ],
  ];
  for (const [label, error, summary] of cases) {
    const first = await firstRun(withMail({ answer: bill() }));
    assert.ok(first.result.outcome === 'success');
    // The same run once more on a platform that refuses the mail: the bill is replayed, not made again.
    first.platform.mail = () => Promise.reject(error);
    const again = await first.automation.execute(first.request, first.platform);
    assert.equal(again.outcome, 'success', label);
    assert.deepEqual(outputOf(again), outputOf(first.result), label);
    const line = first.platform.steps.at(-1);
    assert.deepEqual(
      [line?.stepId, line?.outcome, line?.summary],
      ['notify', 'failed', summary],
      label,
    );
    assert.ok(!JSON.stringify(first.platform.steps).includes(TO), label);
    assert.equal(first.simulator.company.bills.length, 1, label);
  }
});

test('the subject stays at most 200 characters, the Id, number and total whole; no line break from a name reaches it; the same run mails the same words', async () => {
  // QuickBooks answers with the vendor's name at its 500 characters, a line break inside it.
  const long = `Harrowgate ${'Office '.repeat(68)}Supply`;
  const answer = {
    Bill: {
      Id: '151',
      DocNumber: 'HOS-1042',
      TxnDate: '2026-09-14',
      DueDate: '2026-10-14',
      TotalAmt: 413.34,
      VendorRef: { value: '7', name: `${long}\r\nBcc: someone@example.net` },
    },
    time: '2026-10-10T09:00:00.000-07:00',
  };
  const run = withMail({
    answer: bill(),
    company: (sim) => sim.script('bill.create', [{ status: 200, body: answer }]),
  });
  const { mails } = await mailed(run);
  const subject = mails[0]?.subject ?? '';
  assert.ok(subject.length <= 200, String(subject.length));
  assert.match(subject, /^Bill 151 recorded in QuickBooks: Harrowgate .+…, HOS-1042, \$413\.34$/u);
  assert.ok(!/[\r\n]/u.test(subject));
  assert.ok((mails[0]?.body.length ?? 0) <= 10_000);
  const twice = await mailed(run);
  assert.deepEqual(
    twice.mails.map(({ subject: s, body }) => [s, body]),
    mails.map(({ subject: s, body }) => [s, body]),
  );
});

test("the mail never carries a hold reason or a line's text; after an approval it says so", async () => {
  const first = await firstRun(
    withMail({ answer: bill(), config: { ...PAID.company.config, holdAboveAmount: 0 } }),
  );
  const approved = await approve(first);
  const [mail] = approved.mails as [MailRequest];
  for (const absent of ['over the', 'limit', 'Held', 'held', 'category Utilities']) {
    assert.ok(!mail.body.includes(absent) && !mail.subject.includes(absent), absent);
  }
  assert.ok(mail.body.includes('Decided: after approval'));
});
