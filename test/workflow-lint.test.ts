import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The workflows and the kit's workflow lint (README, "The workflow lint"; the prevention plan's
 * "zizmor in CI: every workflow declares its permissions"): Verify runs
 * `node scripts/kit/workflow-lint.mjs` right after its private-data scan, before the install and
 * with no secret; and no workflow writes a `${{ }}` expression inside a run: script, each value
 * reaching it through the step's env (zizmor's template-injection). The nightly's `$/` call and
 * the rest: test/workflow-policy.test.ts. Read as text, with no YAML library.
 */

const workflowsRoot = resolve(import.meta.dirname, '..', '.github', 'workflows');
const workflowFiles = readdirSync(workflowsRoot).filter((name) => /\.ya?ml$/u.test(name));
const read = (name: string) => readFileSync(join(workflowsRoot, name), 'utf8');

test("Verify runs the kit's workflow lint right after the private-data scan, before the install, with no secret", () => {
  const verify = read('ci.yml')
    .split(/^ {2}(?=[a-z][\w-]*:$)/mu)
    .find((block) => block.startsWith('verify:'));
  assert.ok(verify !== undefined, 'ci.yml has a verify job');
  const steps = verify.split(/^ {6}- /mu).slice(1);
  const names = steps.map((step) => /^name: (.*)$/mu.exec(step)?.[1]);
  const scan = names.indexOf('No private data');
  const lint = names.indexOf('Workflow lint');
  assert.ok(scan >= 0, "Verify's private-data scan");
  assert.equal(lint, scan + 1, 'the lint right after the scan');
  assert.ok(lint < names.indexOf('Install dependencies'), 'before the install: Node built-ins');
  assert.match(steps[lint]!, /^ {8}run: node scripts\/kit\/workflow-lint\.mjs$/mu);
  assert.doesNotMatch(steps[lint]!, /env:|secrets\./u, 'no secret and no token reach it');
});

test('no workflow writes a `${{ }}` expression inside a run: script: each value reaches it through env (template-injection)', () => {
  let scripts = 0;
  for (const file of workflowFiles) {
    const lines = read(file).split('\n');
    lines.forEach((line, at) => {
      const run = /^( *)(?:- )?run:(.*)$/u.exec(line);
      if (!run) return;
      scripts += 1;
      const body = [run[2]!];
      for (const next of lines.slice(at + 1)) {
        const indent = next.length - next.trimStart().length;
        if (next.trim() !== '' && indent <= run[1]!.length) break;
        body.push(next);
      }
      assert.doesNotMatch(body.join('\n'), /\$\{\{/u, `${file}:${at + 1}: an expression in run:`);
    });
  }
  assert.ok(scripts > 10, 'the run: scripts were found');
});
