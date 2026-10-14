import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DECIDE_REASONS, PATH_FAILS, type FailRule } from '../src/decide/fails.js';
import { NOT_RECORDED } from '../src/quickbooks-path.js';
import { bill, creditNote, receipt, sampleAnswer, statement } from './check-world.js';
import { VENDOR, agreed, decide, type DecideSetUp } from './decide-world.js';
import { check, documentOf } from './check-world.js';

/**
 * decide's rules (the plan's §2.3 F1–F7, §2.6 per path): each a reason the document is not
 * recorded in QuickBooks — the details saved, never a failed run (the spec's S2) — each rule only on
 * its paths, the first match winning, and every one before any hold.
 */

const RULE_OF = new Map(Object.entries(DECIDE_REASONS).map(([rule, reason]) => [reason, rule]));

/** The rule that kept the document out of QuickBooks, or how decide ended. */
const failure = (setUp: DecideSetUp) => {
  const decision = decide(setUp);
  return decision.outcome === 'not_recorded'
    ? (RULE_OF.get(decision.reason) ?? decision.reason)
    : decision.outcome;
};

test("each rule's reason, in the spec's words (§3.F)", () => {
  const words: Record<FailRule, string> = {
    F1: 'only US dollars work',
    F2: 'the vendor uses another currency',
    F3: 'that date is in closed books',
    F4: "the vendor's name is too long",
    F5: 'credit notes need an existing vendor',
    F6: "the vendor isn't in QuickBooks",
    F7: 'the two reads disagree on the type',
  };
  for (const [rule, reason] of Object.entries(DECIDE_REASONS)) {
    assert.equal(NOT_RECORDED[reason], words[rule as FailRule], rule);
  }
});

test("the rules each path checks, in order (§2.6), a statement's F7 before its F6", () => {
  assert.deepEqual(PATH_FAILS, {
    bill: ['F1', 'F2', 'F3', 'F4'],
    company_receipt: ['F1', 'F2', 'F3'],
    card_refund: ['F1', 'F2', 'F3'],
    vendor_credit: ['F1', 'F2', 'F3', 'F5'],
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
    { answer: statement(euro) },
  ]) {
    assert.equal(failure(setUp), 'F1');
  }
  assert.equal(failure({ answer: bill({ currency: null }) }), 'ok');
  assert.equal(failure({ answer: bill({ currency: 'usd' }) }), 'ok');
  // A code not recognised is not F1: it holds, USD used.
  assert.equal(failure({ answer: bill({ currency: 'US$' }) }), 'held');
});

test('F2: a linked vendor in another currency; none set is the home currency; never where no vendor is linked', () => {
  const cad = { ...VENDOR, currency: 'CAD' };
  for (const setUp of [
    { answer: bill(), vendor: cad },
    { answer: receipt(), vendor: cad },
    { answer: creditNote(), vendor: cad },
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
  // titled "Statement" says the reads disagree on the type, not that the vendor is missing.
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
  // Over the limit, in EUR: not recorded, and no approval is made.
  assert.equal(
    failure({
      answer: receipt({ currency: 'EUR', total: 5000, subtotal: null, tax: null, lineItems: [] }),
    }),
    'F1',
  );
});
