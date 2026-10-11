import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { secondReadOf } from '../src/checks/answers.js';
import type { CheckInput } from '../src/checks/check.js';
import { CHECK_DOCUMENT_REASONS, CHECK_DOCUMENT_SENTENCES } from '../src/checks/rules.js';
import { DECIDE_SENTENCES } from '../src/decide/fails.js';
import { compareReads } from '../src/reads/compare.js';
import type { VerificationState } from '../src/state.js';
import { checkedSummary } from '../src/steps/check-document.js';
import { verifiedSummary } from '../src/steps/verify-read.js';
import { VISA, check, paidBy } from './check-world.js';
import { decide } from './decide-world.js';
import { secondAnswer } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The planted marker (the plan's §2.9): it "never appears in any line, reason, sentence, saved data,
 * QuickBooks request or email, for every type". Each sample's expected answer holds no marker
 * (samples.test.ts), so here each sample's marker is planted in every field the code reads but
 * must never pass on — read 1's currency, card digits, date, due date and the references any
 * document but a statement lists; read 2's currency, card digits and dates — and the run goes
 * through check-document, the second read's comparison and decide on every path, held and
 * straight through. The seller's name, the document number, a credit's original invoice and a
 * statement's listed references are carried by design, so the marker is never planted there.
 */

const MODEL_SERVED = 'google/gemini-3.1-flash-lite';

/** Read 1's answer with `marker` in the fields named, the rest as the sample's expected answer. */
function plantedFirst(answer: JsonObject, marker: string, fields: readonly string[]): JsonObject {
  const planted: JsonObject = structuredClone(answer);
  for (const field of fields) {
    if (field === 'listedItems') {
      // A statement's references are its comparison's, carried by design.
      if (answer.documentType === 'supplier_statement') continue;
      planted.listedItems = [
        ...(answer.listedItems as JsonObject[]),
        { reference: marker, amount: 10, kind: 'invoice' },
      ];
    } else {
      planted[field] = marker;
    }
  }
  return planted;
}

const FIRST_PLANTINGS: readonly (readonly string[])[] = [
  [],
  ['currency', 'cardLast4', 'listedItems'],
  ['cardLast4'],
  ['dueDate'],
  ['documentDate'],
  ['currency', 'cardLast4', 'documentDate', 'dueDate', 'listedItems'],
];
const SECOND_PLANTINGS: readonly (readonly string[])[] = [
  [],
  ['currency', 'cardLast4', 'documentDate', 'dueDate'],
  ['cardLast4'],
  ['dueDate'],
];

/** The paths a sample's document can take: as the company's, and paid personally when a bill or receipt. */
function payersOf(answer: JsonObject): [string, Partial<CheckInput>][] {
  const company: [string, Partial<CheckInput>] = ['company', { paidFrom: VISA }];
  if (answer.documentType !== 'bill' && answer.documentType !== 'receipt') return [company];
  return [
    company,
    ['employee', paidBy('employee', { paidFrom: null })],
    ['owner', paidBy('owner', { paidFrom: null })],
    ['contractor', paidBy('not_employee', { paidFrom: null })],
  ];
}

test("every sample's marker, planted in each field the code must not pass on, reaches no line, reason, wording, sentence, state or saved data — on every path, held and straight through", (t) => {
  /** route → outcome → how many runs ended so with a marker planted. */
  const seen = new Map<string, Map<string, number>>();
  const count = (route: string, outcome: string) => {
    const outcomes = seen.get(route) ?? new Map<string, number>();
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    seen.set(route, outcomes);
  };
  for (const sample of SAMPLES) {
    const { marker } = sample;
    const clean = (what: string, value: unknown) =>
      assert.ok(!JSON.stringify(value).includes(marker), `${sample.name}: the marker in ${what}`);
    for (const [payer, options] of payersOf(sample.answer)) {
      for (const firstFields of FIRST_PLANTINGS) {
        const first = plantedFirst(sample.answer, marker, firstFields);
        const checked = check(first, options);
        if (checked.outcome === 'failed') {
          // The run ends here, in the rule's fixed sentence and reason code.
          const { rule } = checked;
          clean(`check-document's ${rule}`, [
            checked,
            rule === 'answer_unusable'
              ? rule
              : [CHECK_DOCUMENT_SENTENCES[rule], CHECK_DOCUMENT_REASONS[rule]],
          ]);
          if (firstFields.length > 0) count(`${payer} ${String(first.documentType)}`, rule);
          continue;
        }
        const { document } = checked;
        clean('the document check-document keeps', document);
        clean("check-document's line", checkedSummary(document, options.switchOn === true));
        for (const secondFields of SECOND_PLANTINGS) {
          const planted = Object.fromEntries(secondFields.map((field) => [field, marker]));
          const second = secondReadOf(secondAnswer(sample.answer, planted));
          assert.ok(second, `${sample.name}: read 2's schema`);
          const comparison = compareReads(document, second);
          const verification: Extract<VerificationState, { status: 'made' }> = {
            status: 'made',
            modelServed: MODEL_SERVED,
            compared: comparison.compared,
            differences: comparison.differences,
            totalPicked: comparison.totalPicked,
            spendTypeDisputed: comparison.spendTypeDisputed,
          };
          clean('the comparison', comparison);
          clean("verify-read's line", verifiedSummary(MODEL_SERVED, verification));
          const plantedAnywhere = firstFields.length > 0 || secondFields.length > 0;
          for (const holdAboveAmount of [0, 1_000_000]) {
            const decision = decide({
              answer: first,
              check: options,
              verification,
              config: { expenseAccount: 'Utilities:Electric', holdAboveAmount },
            });
            clean(`decide (${decision.outcome})`, decision);
            if (decision.outcome === 'failed') {
              assert.equal(decision.sentence, DECIDE_SENTENCES[decision.failure]);
            }
            if (plantedAnywhere) count(document.route, decision.outcome);
          }
        }
      }
    }
  }
  const outcomes = (route: string) => Object.fromEntries(seen.get(route) ?? []);
  for (const [route, ended] of seen)
    t.diagnostic(`${route}: ${JSON.stringify(Object.fromEntries(ended))}`);
  // Held and straight through, with a marker planted, on every path that records.
  for (const route of ['bill', 'company_receipt', 'card_refund', 'vendor_credit']) {
    assert.ok((outcomes(route).held ?? 0) > 0 && (outcomes(route).ok ?? 0) > 0, route);
  }
  for (const route of ['employee', 'owner', 'contractor']) {
    assert.ok((outcomes(route).held ?? 0) > 0, route);
    assert.equal(outcomes(route).ok, undefined, `${route}: a reimbursement always holds`);
  }
  assert.ok((outcomes('statement').compared ?? 0) > 0, 'a statement compared');
  // A planted date the record needs ends the run at check-document, in a fixed sentence.
  assert.ok((outcomes('company bill').C22 ?? 0) > 0 && (outcomes('company bill').C24 ?? 0) > 0);
  assert.ok((outcomes('employee receipt').C22 ?? 0) > 0);
});
