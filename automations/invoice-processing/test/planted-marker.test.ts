import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { secondReadOf } from '../src/checks/answers.js';
import type { CheckInput } from '../src/checks/check.js';
import { partAnswerOf, v2AnswerOf } from '../src/run/answer.js';
import { checkedEntry, checkedSummary, documentOf } from '../src/run/check.js';
import { runDocumentOf, summarised } from '../src/run/documents.js';
import { documentReadOf } from '../src/run/document-read.js';
import { compared, verifyLine } from '../src/run/settle.js';
import { KIND_OF, type Entry } from '../src/run/state.js';
import { DOUBTS, runSummary } from '../src/run/words.js';
import type { VerificationState } from '../src/state.js';
import { NONE_PATH, TODAY } from './check-world.js';
import { decide } from './decide-world.js';
import { NONE, QUICKBOOKS, documentAnswer, partAnswer, secondAnswer } from './fixtures.js';
import { SAMPLES } from './sample-maker/samples.js';

/**
 * The planted marker (the plan's §2.9): it "never appears in any line, reason, sentence, saved data,
 * QuickBooks request or email, for every type". Each sample's expected answer holds no marker
 * (samples.test.ts), so here each sample's marker is planted in every field the code reads but
 * must never pass on — read 1's currency, card digits, date, due date and the references any
 * document but a statement lists; read 2's currency, card digits and dates — and each document goes
 * through check-documents, the second read's comparison, decide, and the document as the result
 * carries it, QuickBooks chosen or not, held and straight through. The seller's name, the document
 * number, its references, a credit's original invoice and a statement's listed rows are what was
 * read, carried by design (the owner's AM7), so the marker is never planted there.
 */

const MODEL_SERVED = 'google/gemini-3.1-flash-lite';

/** Read 1's answer with `marker` in the fields named, the rest as the sample's expected answer. */
function plantedFirst(answer: JsonObject, marker: string, fields: readonly string[]): JsonObject {
  const planted: JsonObject = structuredClone(answer);
  for (const field of fields) {
    if (field === 'listedItems') {
      // A statement's references are its lines, carried by design.
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

/** One document as read 1 reads it, before the checks. */
function entryOf(answer: JsonObject): Entry {
  const [read] = partAnswerOf(partAnswer([documentAnswer(answer)]))?.documents ?? [];
  assert.ok(read, 'a usable read');
  return {
    index: 1,
    kind: KIND_OF[read.documentType],
    read: documentReadOf(read),
    answer: v2AnswerOf(read),
    doubts: [],
    engine: {},
    stage: 'read',
  };
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
const PATHS: readonly [string, Partial<CheckInput>, JsonObject][] = [
  ['quickbooks', {}, QUICKBOOKS],
  ['none', NONE_PATH, NONE],
];

test("every sample's marker, planted in each field the code must not pass on, reaches no line, reason, summary, state or document — on either path, held and straight through", (t) => {
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
    for (const [path, options, config] of PATHS) {
      const request = { config };
      for (const firstFields of FIRST_PLANTINGS) {
        const first = plantedFirst(sample.answer, marker, firstFields);
        const checked = checkedEntry(entryOf(first), path === 'quickbooks', TODAY);
        // The first read itself is kept, unpublished, for the second read to fill its gaps.
        const { answer: _kept, ...entry } = checked;
        clean('the entry check-documents keeps', entry);
        clean('the document as the result carries it', runDocumentOf(checked, request));
        clean('the summary', runSummary([summarised(checked, request)]));
        const planted = firstFields.length > 0;
        if (checked.unsettled !== undefined) {
          // Left for the second read, in its fixed words.
          clean(`the doubt ${checked.unsettled}`, DOUBTS[checked.unsettled]);
          if (planted) count(`${path} ${String(first.documentType)}`, checked.unsettled);
          continue;
        }
        const document = documentOf(checked.engine);
        if (!document) continue;
        clean("check-documents' line", checkedSummary(document));
        const stop = checked.engine.quickBooks as { notRecorded?: string } | undefined;
        if (stop?.notRecorded !== undefined) {
          // Not recorded in QuickBooks: the document goes on to be saved, in a fixed reason.
          if (planted) count(`${path} ${String(first.documentType)}`, stop.notRecorded);
          continue;
        }
        if (path === 'none') continue;
        for (const secondFields of SECOND_PLANTINGS) {
          const plantedSecond = Object.fromEntries(secondFields.map((field) => [field, marker]));
          const second = secondReadOf(secondAnswer(sample.answer, plantedSecond));
          assert.ok(second, `${sample.name}: read 2's schema`);
          const after = compared(checked, second, {
            quickBooks: true,
            today: TODAY,
            model: MODEL_SERVED,
          });
          const { answer: _first, ...kept } = after;
          clean('the comparison', kept);
          clean("verify-read's line", verifyLine([after], [checked]));
          const verification = after.engine.verification as unknown as Extract<
            VerificationState,
            { status: 'made' }
          >;
          const plantedAnywhere = planted || secondFields.length > 0;
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
  // A planted date leaves the document for the second read, on either path; a planted due date
  // only keeps it out of QuickBooks.
  assert.ok((outcomes('quickbooks bill').C22 ?? 0) > 0 && (outcomes('none bill').C22 ?? 0) > 0);
  assert.ok((outcomes('quickbooks bill')["the due date can't be read"] ?? 0) > 0);
  assert.equal(outcomes('none bill')["the due date can't be read"], undefined);
});
