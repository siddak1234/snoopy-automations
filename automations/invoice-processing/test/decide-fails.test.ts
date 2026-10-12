import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DECIDE_SENTENCES, PATH_FAILS, type FailRule } from '../src/decide/fails.js';
import { bill, creditNote, paidBy, receipt, sampleAnswer, statement } from './check-world.js';
import { VENDOR, agreed, decide, type DecideSetUp } from './decide-world.js';
import { check, documentOf } from './check-world.js';

/**
 * decide's fail rules (the plan's §2.3 F1–F7, §2.6 per path): each sentence exact, each rule only
 * on its paths, the first match winning, and every fail before any hold.
 */

const failure = (setUp: DecideSetUp) => {
  const decision = decide(setUp);
  return decision.outcome === 'failed' ? decision.failure : decision.outcome;
};

test('the sentences, word for word as the plan gives them, each at most 200 characters', () => {
  const plan: Record<FailRule, string> = {
    F1: 'This document is not in USD, and this automation records USD only. Enter it by hand in QuickBooks.',
    F2: 'This vendor is set up in QuickBooks in another currency, and this automation records USD only.',
    F3: "The document's date is in a period closed in QuickBooks.",
    F4: "The vendor's name is too long to add '(vendor)' in QuickBooks. Enter this bill by hand.",
    F5: "This credit note's vendor isn't in QuickBooks. Credit notes are recorded only for existing vendors.",
    F6: "This statement's vendor isn't in QuickBooks, so there is nothing to compare it with.",
    F7: 'The two reads disagree on whether this is a supplier statement. Check the document, and if it is a bill, enter it by hand in QuickBooks.',
  };
  for (const [rule, sentence] of Object.entries(plan)) {
    assert.equal(DECIDE_SENTENCES[rule as FailRule], `${sentence} Nothing was created.`, rule);
  }
  for (const sentence of Object.values(DECIDE_SENTENCES))
    assert.ok(sentence.length <= 200, sentence);
  assert.equal(
    DECIDE_SENTENCES.state_incomplete,
    'Bills & Receipts could not finish its checks. Run it again. Nothing was created.',
  );
  assert.equal(
    DECIDE_SENTENCES.saved_too_large,
    'Bills & Receipts could not save this document for approval. Run it again. Nothing was created.',
  );
});

test("the rules each path checks, in order (§2.6), a statement's F7 before its F6", () => {
  assert.deepEqual(PATH_FAILS, {
    bill: ['F1', 'F2', 'F3', 'F4'],
    company_receipt: ['F1', 'F2', 'F3'],
    card_refund: ['F1', 'F2', 'F3'],
    vendor_credit: ['F1', 'F2', 'F3', 'F5'],
    employee: ['F1', 'F3'],
    owner: ['F1', 'F3'],
    contractor: ['F1', 'F2', 'F3'],
    statement: ['F1', 'F2', 'F7', 'F6'],
  });
});

test('F1: a printed currency other than USD, on every path; none printed or USD goes on', () => {
  const euro = { currency: 'EUR' };
  for (const setUp of [
    { answer: bill(euro) },
    { answer: receipt(euro) },
    { answer: creditNote(euro) },
    { answer: sampleAnswer('card-refund', euro) },
    { answer: receipt(euro), check: paidBy('employee', { paidFrom: null }) },
    { answer: statement(euro) },
  ]) {
    assert.equal(failure(setUp), 'F1');
  }
  assert.notEqual(failure({ answer: bill({ currency: null }) }), 'failed');
  assert.notEqual(failure({ answer: bill({ currency: 'usd' }) }), 'failed');
  // A code not recognised is not F1: it holds, USD used.
  assert.equal(failure({ answer: bill({ currency: 'US$' }) }), 'held');
});

test('F2: a linked vendor in another currency; none set is the home currency; never where no vendor is linked', () => {
  const cad = { ...VENDOR, currency: 'CAD' };
  for (const setUp of [
    { answer: bill(), vendor: cad },
    { answer: receipt(), vendor: cad },
    { answer: creditNote(), vendor: cad },
    { answer: receipt(), check: paidBy('not_employee', { paidFrom: null }), vendor: cad },
    { answer: statement(), vendor: cad },
  ]) {
    assert.equal(failure(setUp), 'F2');
  }
  assert.equal(failure({ answer: bill(), vendor: { ...VENDOR, currency: 'USD' } }), 'ok');
  assert.equal(failure({ answer: bill() }), 'ok', 'no CurrencyRef: the home currency, USD');
  assert.equal(
    failure({ answer: bill(), preferences: { homeCurrency: 'CAD' } }),
    'F2',
    'no CurrencyRef, a CAD home',
  );
  // A receipt whose seller is no vendor has none to weigh.
  assert.equal(failure({ answer: receipt(), vendor: { status: 'new' } }), 'ok');
});

test('F3: dated on or before the closing date, for every record written; not given, the check is skipped', () => {
  const closed = { bookCloseDate: '2026-09-14' };
  assert.equal(failure({ answer: bill(), preferences: closed }), 'F3', 'on the closing date');
  assert.equal(
    failure({ answer: bill({ documentDate: '2026-09-01', dueDate: null }), preferences: closed }),
    'F3',
  );
  assert.equal(
    failure({ answer: bill({ documentDate: '2026-09-15' }), preferences: closed }),
    'ok',
  );
  assert.equal(failure({ answer: bill(), preferences: { bookCloseDate: null } }), 'ok');
  for (const setUp of [
    { answer: receipt(), preferences: { bookCloseDate: '2026-09-30' } },
    { answer: creditNote(), preferences: { bookCloseDate: '2026-09-30' } },
    {
      answer: receipt(),
      check: paidBy('owner', { paidFrom: null }),
      preferences: { bookCloseDate: '2026-09-30' },
    },
  ]) {
    assert.equal(failure(setUp), 'F3');
  }
  // A statement is not written.
  assert.equal(
    failure({ answer: statement(), preferences: { bookCloseDate: '2026-12-31' } }),
    'compared',
  );
});

test("F4: a new vendor whose '(vendor)' name would pass 500 characters", () => {
  const long = bill({ vendorName: 'V'.repeat(495) });
  assert.equal(
    failure({ answer: long, vendor: { status: 'new' }, customerNameClash: 'match' }),
    'F4',
  );
  assert.equal(
    failure({ answer: long, vendor: { status: 'new' } }),
    'held',
    'no clash: the printed name',
  );
  assert.equal(
    failure({
      answer: bill({ vendorName: 'V'.repeat(491) }),
      vendor: { status: 'new' },
      employeeNameClash: 'match',
    }),
    'held',
  );
});

test('F5 and F6: a credit note or a statement whose vendor QuickBooks does not have', () => {
  assert.equal(failure({ answer: creditNote(), vendor: { status: 'new' } }), 'F5');
  assert.equal(failure({ answer: statement(), vendor: { status: 'new' } }), 'F6');
  // A card refund needs no vendor (D20).
  assert.equal(failure({ answer: sampleAnswer('card-refund'), vendor: { status: 'new' } }), 'ok');
});

test('F7: read 1 says a supplier statement and read 2 does not; read 2 not made is no disagreement', () => {
  const document = documentOf(check(statement()));
  const parted = {
    ...agreed(document),
    differences: [{ field: 'documentType' as const, first: 'supplier statement', second: 'bill' }],
  };
  assert.equal(failure({ answer: statement(), verification: parted }), 'F7');
  assert.equal(
    failure({ answer: statement(), verification: { status: 'not_made', reason: 'no_answer' } }),
    'compared',
  );
});

test('the first rule wins, and every fail comes before any hold', () => {
  // EUR, a vendor in CAD, a closed period: F1.
  assert.equal(
    failure({
      answer: bill({ currency: 'EUR' }),
      vendor: { ...VENDOR, currency: 'CAD' },
      preferences: { bookCloseDate: '2026-12-31' },
    }),
    'F1',
  );
  // A CAD vendor and a closed period: F2.
  assert.equal(
    failure({
      answer: bill(),
      vendor: { ...VENDOR, currency: 'CAD' },
      preferences: { bookCloseDate: '2026-12-31' },
    }),
    'F2',
  );
  // An unknown statement vendor whose type read 2 disputes: F7 before F6, so a first-time bill
  // titled "Statement" gets F7's "enter it by hand", not F6's "nothing to compare it with".
  const document = documentOf(check(statement()));
  assert.equal(
    failure({
      answer: statement(),
      vendor: { status: 'new' },
      verification: {
        ...agreed(document),
        differences: [{ field: 'documentType', first: 'supplier statement', second: 'bill' }],
      },
    }),
    'F7',
  );
  // Undisputed — the reads agree, or read 2 was not made — an unknown statement vendor is F6.
  assert.equal(failure({ answer: statement(), vendor: { status: 'new' } }), 'F6');
  assert.equal(
    failure({
      answer: statement(),
      vendor: { status: 'new' },
      verification: { status: 'not_made', reason: 'no_answer' },
    }),
    'F6',
  );
  // Over the limit and paid personally, in EUR: it fails, and no approval is made.
  assert.equal(
    failure({
      answer: receipt({ currency: 'EUR', total: 5000, subtotal: null, tax: null, lineItems: [] }),
      check: paidBy('employee', { paidFrom: null }),
    }),
    'F1',
  );
});
