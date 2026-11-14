import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { newestManifests, optionalFileProblems, reasonFor, type Json } from './file-required.js';

/**
 * The owner's rule of 2026-11-14 (`test/file-required.ts`): every flow's newest manifest asks for
 * its file, or its spec says why not; and the rule bitten on copies changed to break it.
 */

const root = resolve(import.meta.dirname, '..');
const manifestsRoot = join(root, 'manifests');
const read = (file: string) =>
  JSON.parse(readFileSync(join(manifestsRoot, file), 'utf8')) as Json & { trigger: Json };
const specOf = (templateId: string) => {
  const path = join(root, 'automations', templateId, 'README.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
};

test("every flow's newest manifest asks for its file, or its spec gives the reason", () => {
  const newest = newestManifests(readdirSync(manifestsRoot));
  assert.deepEqual(newest, [
    'candidate-reviewer.v5.json',
    'icd10-code-check.v5.json',
    'invoice-processing.v9.json',
  ]);
  for (const file of newest) {
    const manifest = read(file);
    assert.deepEqual(
      optionalFileProblems(file, manifest, specOf(String(manifest.templateId))),
      [],
      file,
    );
  }
});

test('the newest version alone is judged, by its number', () => {
  assert.deepEqual(
    newestManifests(['a.v2.json', 'a.v10.json', 'a.v9.json', 'b.v1.json', 'README.md']),
    ['a.v10.json', 'b.v1.json'],
  );
});

test('an optional file field is refused unless its row says "no: <reason>"', () => {
  const v5 = read('candidate-reviewer.v5.json');
  const [resume] = v5.trigger.input as [Json];
  const optional = { ...v5, trigger: { ...v5.trigger, input: [{ ...resume, required: false }] } };
  const row = (required: string) =>
    `| Key | Title | Required |\n| --- | --- | --- |\n| resumeFile | Resume | ${required} |\n`;
  const refused = [
    'manifests/candidate-reviewer.v5.json: trigger.input[0] (resumeFile) is a file field not ' +
      'required, with no reason: make it required, or write "no: <the reason>" in the Required ' +
      'cell of its row in automations/candidate-reviewer/README.md',
  ];
  const problems = (spec: string | undefined) =>
    optionalFileProblems('candidate-reviewer.v5.json', optional, spec);
  assert.deepEqual(problems(undefined), refused, 'no spec');
  assert.deepEqual(problems(row('yes')), refused, 'its row says yes');
  assert.deepEqual(problems(row('no')), refused, 'no, with no reason');
  assert.deepEqual(problems(row('no:   ')), refused, 'no:, with no reason');
  assert.deepEqual(problems(row('yes').replace('resumeFile', 'other')), refused, 'another row');
  assert.deepEqual(problems(row('no: a run may start without one, the flow asks later')), []);
  assert.deepEqual(problems(row('No: `resumeFile` comes by email')), [], 'its case aside');
  assert.equal(
    reasonFor(row('no: a reason').replace('resumeFile', '`resumeFile`'), 'resumeFile'),
    'a reason',
  );
  // A required file, or an optional field that is no file, asks nothing of the spec.
  assert.deepEqual(optionalFileProblems('candidate-reviewer.v5.json', v5, undefined), []);
  const text = { ...resume, control: 'text', required: false };
  assert.deepEqual(
    optionalFileProblems(
      'x.v1.json',
      { ...v5, trigger: { ...v5.trigger, input: [text] } },
      undefined,
    ),
    [],
  );
});
