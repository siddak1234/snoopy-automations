import assert from 'node:assert/strict';
import { test } from 'node:test';

import { idempotencyKeyFor, type JsonObject, type MailRequest } from '@autom8x/automation-sdk';
import { refusalFixture } from '@autom8x/automation-sdk/testing';

import { bill, receipt, statement } from './check-world.js';
import { NONE, setUp, reads } from './fixtures.js';
import { PAID, type RouteRun } from './lookups-world.js';
import { approve, firstRun, outputOf } from './writes-world.js';

/**
 * notify (the last step; v2's §3.F): one plain-text mail to the "Also email" address — skipped,
 * unreported, when it is empty. Its subject is the result line; its body one first line saying what
 * Invoice Processing did, then the run's details as `Label: value` lines, and nothing else — never
 * the model's words or a hold reason. A mail that fails never fails the run, and the step's line
 * (§3.E: `Summary emailed`) never carries the address or the mail's words.
 */

const TO = 'books@example.com';
const withMail = (run: RouteRun, mail: JsonObject = { notifyEmail: TO }): RouteRun => ({
  ...run,
  config: { ...(run.config ?? PAID.company.config), ...mail },
});

/** The mail a whole run sent — approved, when it held — and the notify line. */
async function mailed(run: RouteRun) {
  const first = await firstRun({ ...run, through: 'all' });
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

test("a bill's mail, straight through: the result line as its subject, the first line, the details — under notify's own key", async () => {
  const { mails, line, runId } = await mailed(withMail({ answer: bill() }));
  assert.deepEqual(mails, [
    {
      to: TO,
      subject: 'Recorded in QuickBooks: bill from Harrowgate Office Supply, $413.34',
      body: [
        'Invoice Processing recorded this in QuickBooks.',
        '',
        'Recorded as: Bill',
        'Vendor: Harrowgate Office Supply',
        'Number: HOS-1042',
        'Date: Sep 14, 2026',
        'Due: Oct 14, 2026',
        'Total: $413.34',
        'Category: Office Supplies',
        'Decided: Automatically',
      ].join('\n'),
      idempotencyKey: idempotencyKeyFor(runId, 'notify'),
    },
  ]);
  assert.deepEqual(line, ['notify', 'ok', 'Summary emailed']);
});

test("a receipt's mail: Paid from, and the next step", async () => {
  const { mails } = await mailed(withMail({ answer: receipt() }));
  assert.equal(mails[0]?.subject, 'Recorded in QuickBooks: expense from Tidewell Hardware, $60.63');
  const body = mails[0]?.body.split('\n') ?? [];
  assert.equal(body[0], 'Invoice Processing recorded this in QuickBooks.');
  assert.ok(body.includes('Paid from: Visa 4417'), body.join('\n'));
  assert.equal(
    body.at(-1),
    'Next: When this charge arrives in your bank feed, choose Match, not Add.',
  );
});

test("a statement's mail: compared, with what QuickBooks shows — never the statement's invoice numbers", async () => {
  const { mails, result } = await mailed(withMail({ answer: statement() }));
  assert.equal(outputOf(result).outcome, 'compared');
  assert.equal(mails[0]?.subject, 'Statement from Harrowgate Office Supply compared');
  const body = mails[0]?.body.split('\n') ?? [];
  assert.deepEqual(body.slice(0, 3), [
    'Invoice Processing compared this statement with QuickBooks.',
    '',
    'Vendor: Harrowgate Office Supply',
  ]);
  assert.ok(body.some((each) => /^Not in QuickBooks: \d+ invoices?$/u.test(each)));
  for (const own of ['HOS-1031', 'HOS-1050']) {
    assert.ok(!mails[0]?.body.includes(own), own);
  }
});

test('the vendor "None": the saved details mailed, and still nothing calls QuickBooks', async () => {
  const world = setUp({ through: 'all', config: { ...NONE, notifyEmail: TO } });
  world.platform.model = reads(bill());
  const result = await world.run();
  assert.equal(result.outcome, 'success');
  assert.deepEqual(world.platform.providerCalls, []);
  const [mail] = world.platform.mails as [MailRequest];
  assert.equal(mail.subject, 'Saved: Harrowgate Office Supply, $413.34');
  assert.deepEqual(mail.body.split('\n').slice(0, 4), [
    'Invoice Processing saved these details.',
    '',
    'Type: Bill',
    'Seller: Harrowgate Office Supply',
  ]);
});

test("QuickBooks' answer wins over what was read: its total and the vendor's name as it wrote them", async () => {
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
    'Recorded in QuickBooks: bill from Harrowgate Office Supply Co., $413.35',
  );
  assert.match(mails[0]?.body ?? '', /\nDue: Oct 15, 2026\nTotal: \$413\.35\n/u);
  assert.equal(
    (result as { summary?: string }).summary,
    'Recorded in QuickBooks: bill from Harrowgate Office Supply Co., $413.35.',
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
      'Summary not emailed',
    ],
    [
      'the daily cap',
      refusalFixture('mail', {
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        detail: 'x',
        details: { reason: 'per_workspace_daily_cap' },
      }),
      'Summary not emailed',
    ],
    [
      'mail not configured',
      refusalFixture('mail', { status: 503, code: 'NOT_CONFIGURED', detail: 'x' }),
      'Summary not emailed',
    ],
    ['no answer', new TypeError('fetch failed'), 'Summary may have been emailed'],
    [
      'a reasonless 502',
      refusalFixture('mail', { status: 502, code: 'DEPENDENCY_FAILURE', detail: 'x' }),
      'Summary may have been emailed',
    ],
  ];
  for (const [label, error, summary] of cases) {
    const first = await firstRun({ ...withMail({ answer: bill() }), through: 'all' });
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

test('the subject stays one short line: a long name shortened, no line break from a name reaches it; the same run mails the same words', async () => {
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
  assert.ok(subject.length <= 120, String(subject.length));
  assert.match(subject, /^Recorded in QuickBooks: bill from Harrowgate .+…, \$413\.34$/u);
  assert.ok(!/[\r\n]/u.test(subject));
  assert.ok(!(mails[0]?.body ?? '').includes('\nBcc:'));
  assert.ok((mails[0]?.body.length ?? 0) <= 10_000);
  const twice = await mailed(run);
  assert.deepEqual(
    twice.mails.map(({ subject: s, body }) => [s, body]),
    mails.map(({ subject: s, body }) => [s, body]),
  );
});

test("the mail never carries a hold reason or a line's text; after an approval it says so", async () => {
  const first = await firstRun({
    ...withMail({ answer: bill(), config: { ...PAID.company.config, holdAboveAmount: 0 } }),
    through: 'all',
  });
  const approved = await approve(first);
  const [mail] = approved.mails as [MailRequest];
  for (const absent of ['over the', 'limit', 'Waiting', 'approval.', 'Checks passed']) {
    assert.ok(!mail.body.includes(absent) && !mail.subject.includes(absent), absent);
  }
  assert.ok(mail.body.includes('Decided: After approval'));
});
