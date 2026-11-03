import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { flow, reading, type Dx } from './fixtures.js';
import { reviewChild, runChild } from './v2-fixtures.js';

/**
 * T3 (the owner's T1 and T3, 2026-11-01): the deterministic chain — the index lookup and the
 * choices, the no-AI keep, gate B, the checks and the save — graded on about 30 made-up notes'
 * recorded AI answers (`notes.json` in the tests' accuracy folder: each note as `read-note` would answer it, each
 * diagnosis with the code the recorded `match-codes` answer picks, given only when it is listed)
 * against the draft answer key (`key.json` beside it, awaiting the clinic's owner's or admin's approval). Every
 * change is accepted, as a coder would who agrees with the key. A score below the key's baseline
 * fails the build.
 */

const folder = join(flow, 'test', 'accuracy');
const { notes } = JSON.parse(readFileSync(join(folder, 'notes.json'), 'utf8')) as {
  notes: { id: string; codesOnNote: string[]; diagnoses: (Dx & { pick: string })[] }[];
};
const key = JSON.parse(readFileSync(join(folder, 'key.json'), 'utf8')) as {
  status: string;
  baseline: { notesRight: number; codesRight: number; codesExtra: number; settled: number };
  answers: Record<string, string[]>;
};

test("the answer key is a draft until the clinic's owner or admin approves it", () => {
  assert.equal(key.status, "draft — awaiting the clinic's owner's or admin's approval");
  assert.equal(notes.length, Object.keys(key.answers).length);
  assert.ok(notes.length >= 30);
});

test('T3: the chain on the recorded answers scores no lower than the baseline', async (t) => {
  const score = { notesRight: 0, codesRight: 0, codesExtra: 0, settled: 0 };
  const missed: string[] = [];
  for (const one of notes) {
    const note = reading(one.codesOnNote, one.diagnoses);
    const picks = Object.fromEntries(one.diagnoses.map((d) => [d.statement, { code: d.pick }]));
    const ran = await runChild(note, picks, { config: {} });
    let { result } = ran;
    if (result.outcome === 'held') {
      const all = Object.fromEntries(
        (result.held.decisions ?? []).map((d) => [d.id, 'accepted' as const]),
      );
      result = (await reviewChild(ran, all, note)).result;
    }
    assert.equal(result.outcome, 'success', `${one.id}: ${JSON.stringify(result)}`);
    const output = result.outcome === 'success' ? (result.output ?? {}) : {};
    const final = new Set(output.finalCodes as string[]);
    const want = new Set(key.answers[one.id]);
    const right = [...final].filter((code) => want.has(code)).length;
    score.codesRight += right;
    score.codesExtra += final.size - right;
    score.settled += (output.measures as { settled?: number }).settled ?? 0;
    if (right === want.size && final.size === want.size) score.notesRight += 1;
    else missed.push(`${one.id}: ${[...final].join(' ')} (key ${[...want].join(' ')})`);
  }
  t.diagnostic(`score ${JSON.stringify(score)}; missed ${missed.join('; ')}`);
  assert.ok(score.notesRight >= key.baseline.notesRight, `notes right ${score.notesRight}`);
  assert.ok(score.codesRight >= key.baseline.codesRight, `codes right ${score.codesRight}`);
  assert.ok(score.codesExtra <= key.baseline.codesExtra, `codes extra ${score.codesExtra}`);
  assert.ok(score.settled >= key.baseline.settled, `settled with no AI ${score.settled}`);
});
