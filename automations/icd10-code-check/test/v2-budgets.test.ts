import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESULT_BODY_LIMIT_BYTES, type RunResult } from '@autom8x/automation-sdk';
import {
  answerReview,
  type RecordingMemory,
  type RecordingPlatform,
} from '@autom8x/automation-sdk/testing';

import { define } from '../src/automation.js';
import { manifests, platformFor, reading, type Dx } from './fixtures.js';
import { runChild } from './v2-fixtures.js';

/**
 * The owner's A4 budgets (2026-11-01), measured on a visit's run, its review and its save: AI
 * calls at most 2 for a visit of one file and at most 8 diagnoses to match (one read, one match),
 * and no match call once every diagnosis is settled; platform calls (model, provider, file and
 * memory) at most 15; and every message — the held result, the answered invoke, the final result —
 * at most the platform's 256 KiB, for a visit of 40 long diagnoses too.
 */

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** The platform's calls a run makes — model, provider, file and memory — on `store`'s memory. */
function counted(platform: RecordingPlatform, store: RecordingMemory = platform.memory) {
  let memory = 0;
  platform.memory = {
    get: (key: string) => ((memory += 1), store.get(key)),
    put: (key: string, value: unknown) => ((memory += 1), store.put(key, value)),
  } as unknown as RecordingMemory;
  return () =>
    platform.modelCalls.length +
    platform.providerCalls.length +
    platform.artifactReads.length +
    memory;
}

const flow = () => define(manifests, { today: () => '2026-10-28' });

async function visit(diagnoses: Dx[], codes: string[], npi = false) {
  const note = reading(codes, diagnoses);
  const picks = Object.fromEntries(diagnoses.map((d) => [d.statement, { code: 'N18.31' }]));
  const first = platformFor(note, picks);
  const store = first.memory;
  const config = npi ? { npi: '1234567893' } : { specialties: ['207RN0300X'] };
  if (npi) first.provider = () => Promise.resolve({ status: 200, body: { results: [] } });
  const before = counted(first, store);
  const held = await runChild(note, picks, { platform: first, config });
  const messages: number[] = [bytes(held.result)];
  let ai = first.modelCalls.length;
  let platformCalls = before();
  let done: RunResult = held.result;
  if (held.result.outcome === 'held') {
    const answers = Object.fromEntries(
      (held.result.held.decisions ?? []).map((d) => [d.id, 'accepted' as const]),
    );
    const next = answerReview(held.platform, held.request, answers);
    messages.push(bytes(next));
    const second = platformFor(note);
    const after = counted(second, store);
    await second.reportResult(next.runId, await flow().execute(next, second));
    ai += second.modelCalls.length;
    platformCalls += after();
    done = second.results.at(-1)!.result;
  }
  assert.equal(done.outcome, 'success', JSON.stringify(done).slice(0, 300));
  messages.push(bytes(done));
  return { ai, platformCalls, messages };
}

test('A4: at most 2 AI calls a visit, none to match once every diagnosis is settled', async (t) => {
  const typical = await visit(
    [
      { statement: 'Hypertension', categories: ['I10'] },
      { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
    ],
    ['I10', 'N18.30'],
  );
  assert.ok(typical.ai <= 2, `${typical.ai} AI calls`);
  const settled = await visit([{ statement: 'Hypertension', categories: ['I10'] }], ['I10']);
  assert.equal(settled.ai, 1, 'the read alone');
  t.diagnostic(`AI calls: ${typical.ai} a visit, ${settled.ai} settled`);
});

test('A4: at most 15 platform calls a visit, its NPI looked up, reviewed and saved', async (t) => {
  const { platformCalls } = await visit(
    [
      { statement: 'Hypertension', categories: ['I10'] },
      { statement: 'CKD stage 3a, eGFR 52 today', categories: ['N18'] },
    ],
    ['I10', 'N18.30'],
    true,
  );
  assert.ok(platformCalls <= 15, `${platformCalls} platform calls`);
  t.diagnostic(`platform calls: ${platformCalls}`);
});

test('A4: every message at most 256 KiB, for 40 long diagnoses too', async (t) => {
  const long = Array.from({ length: 40 }, (_, i) => ({
    statement: `Chronic kidney disease stage 3a with long words ${i} `.padEnd(200, 'x').trim(),
    categories: ['N18'],
  }));
  const { messages } = await visit(long, ['N18.30']);
  t.diagnostic(`messages: ${messages.map((n) => Math.round(n / 1024)).join(', ')} KiB`);
  assert.ok(
    messages.every((size) => size <= RESULT_BODY_LIMIT_BYTES),
    `${messages.map((n) => Math.round(n / 1024)).join(', ')} KiB`,
  );
});
