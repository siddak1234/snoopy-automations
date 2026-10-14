import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { secondReadOf } from '../src/checks/answers.js';
import type { CheckInput } from '../src/checks/check.js';
import { CHECK_DOCUMENT_REASONS, RECORDING_RULES } from '../src/checks/rules.js';
import { readOf, savedDetails } from '../src/details.js';
import { NOT_RECORDED } from '../src/quickbooks-path.js';
import { compareReads } from '../src/reads/compare.js';
import type { VerificationState } from '../src/state.js';
import { checkedSummary } from '../src/steps/check-document.js';
import { verifiedSummary } from '../src/steps/verify-read.js';
import { RUN_FAILS } from '../src/words.js';
import { NONE_PATH, check } from './check-world.js';
import { decide } from './decide-world.js';
import { secondAnswer } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The planted marker (the plan's §2.9): it "never appears in any line, reason, sentence, saved data,
 * QuickBooks request or email, for every type". Each sample's expected answer holds no marker
 * (samples.test.ts), so here each sample's marker is planted in every field the code reads but
 * must never pass on — read 1's currency, card digits, date, due date and the references any
 * document but a statement lists; read 2's currency, card digits and dates — and the run goes
 * through check-document, the second read's comparison, the details saved, and decide, QuickBooks
 * chosen or not, held and straight through. The seller's name, the document number, a credit's original invoice and a
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

/** The two paths: QuickBooks chosen, and the vendor "None" — where decide never runs. */
const PATHS: readonly [string, Partial<CheckInput>][] = [
  ['quickbooks', {}],
  ['none', NONE_PATH],
];

test("every sample's marker, planted in each field the code must not pass on, reaches no line, reason, sentence, details, state or saved data — on either path, held and straight through", (t) => {
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
    for (const [path, options] of PATHS) {
      for (const firstFields of FIRST_PLANTINGS) {
        const first = plantedFirst(sample.answer, marker, firstFields);
        const checked = check(first, options);
        if (checked.outcome === 'failed') {
          // The run ends here, in the rule's fixed sentence and reason code.
          const { rule } = checked;
          clean(`check-document's ${rule}`, [
            checked,
            rule === 'answer_unusable'
              ? RUN_FAILS.unreadable
              : [RUN_FAILS[rule], CHECK_DOCUMENT_REASONS[rule]],
          ]);
          if (firstFields.length > 0) count(`${path} ${String(first.documentType)}`, rule);
          continue;
        }
        const { document, recordingRule } = checked;
        clean('the document check-document keeps', document);
        clean("check-document's line", checkedSummary(document));
        clean('the details saved', savedDetails(readOf(document), null));
        if (recordingRule !== undefined) {
          // Not recorded in QuickBooks: the run goes on to save the details, in a fixed reason.
          const reason = NOT_RECORDED[RECORDING_RULES[recordingRule]];
          clean(`the reason for ${recordingRule}`, [
            reason,
            savedDetails(readOf(document), { notRecorded: reason }),
          ]);
          if (firstFields.length > 0) count(`${path} ${String(first.documentType)}`, recordingRule);
          continue;
        }
        if (path === 'none') continue;
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
          clean("verify-read's line", verifiedSummary(verification));
          const plantedAnywhere = firstFields.length > 0 || secondFields.length > 0;
          for (const holdAboveAmount of [0, 1_000_000]) {
            const decision = decide({
              answer: first,
              check: options,
              verification,
              config: { holdAboveAmount },
            });
            clean(`decide (${decision.outcome})`, decision);
            assert.notEqual(decision.outcome, 'failed', sample.name);
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
  assert.ok((outcomes('statement').compared ?? 0) > 0, 'a statement compared');
  // A planted date ends the run at check-document, in a fixed sentence, on either path; a planted
  // due date only keeps it out of QuickBooks.
  assert.ok((outcomes('quickbooks bill').C22 ?? 0) > 0 && (outcomes('none bill').C22 ?? 0) > 0);
  assert.ok((outcomes('quickbooks bill').C24 ?? 0) > 0);
  assert.equal(outcomes('none bill').C24, undefined);
});
