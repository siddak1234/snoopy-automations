import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type Any,
  finding,
  lensOut,
  BRIEF,
  skepticSays,
  normalWith,
  normal,
  run,
  render,
  RANKED,
  COLUMNS,
} from './flow-research.js';

/**
 * `.claude/workflows/flow-research.js` under stand-in agents (`test/flow-research.ts`): its
 * integrations stage — the ranking, the researchers, the community-report rule, the first to
 * build and the Integrations table research.md renders.
 */

test('integrations: at most five researched after the lenses, three at once, fifteen calls each', async () => {
  const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ name, menu: 'to add' }));
  const r = await run((label, attempt, prompt, dir) =>
    label === 'adoption lens'
      ? { ...lensOut('adoption'), integrations: seven }
      : normal(label, attempt, prompt, dir),
  );
  const each = r.calls.filter((c) => c.label.startsWith('integration-'));
  assert.deepEqual(
    each.map((c) => c.label),
    ['A', 'B', 'C', 'D', 'E'].map((n, k) => `integration-${k + 1} lens (${n})`),
  );
  assert.ok(r.peak <= 3, `peak ${r.peak}`);
  const lensesEnd = Math.max(
    ...['practice', 'rules', 'adoption', 'streamlining'].map((l) => r.finishedAt[`${l} lens`]!),
  );
  assert.ok(
    each.every((c) => c.startedAt > lensesEnd),
    'after the lenses',
  );
  for (const c of each) {
    assert.ok(c.prompt.includes('At most 15 tool calls'), 'fifteen calls');
    for (const part of ['docs —', 'in practice —', 'cost —', 'constraints and concerns —', 'MCP'])
      assert.ok(c.prompt.includes(part), part);
  }
  const practice = r.calls.find((c) => c.label === 'practice lens')!.prompt;
  const adoption = r.calls.find((c) => c.label === 'adoption lens')!.prompt;
  assert.ok(
    practice.includes('At most 10 tool calls') && adoption.includes('At most 15 tool calls'),
  );
  for (const n of ['F', 'G'])
    assert.ok(r.data.gaps.includes(`adoption: "${n}" past the cap of 5; not researched`), n);
  const rules = r.calls.find((c) => c.label === 'rules lens')!.prompt;
  assert.ok(rules.includes("the model vendors' rules that bind our own AI calls"));
});

test('a community report: kept for a practice line, never for a price, a limit or a rule', async () => {
  const { data } = await run(normal);
  assert.ok(data.gaps.includes('integration-1-3: a tier 4 page, a lead only; dropped'));
  assert.ok(data.sources.some((s: Any) => s.id === 'integration-1-2' && s.tier === 'T4'));
  const kept = data.brief.integrations.map((l: Any) => `${l.integration} ${l.column}`);
  assert.deepEqual(kept, ['integration-1 adoption', 'integration-1 api', 'integration-1 practice']);
  assert.ok(
    data.gaps.includes(
      'integrations: "QuickBooks, cost: free" — integration-1-2 is T4; cite dropped',
    ),
  );
  assert.ok(data.gaps.includes('integrations: "QuickBooks, cost: free" — no source; dropped'));
});

test('first to build: kept on confirmed ids, else "a person decides" and a gap', async () => {
  const ok = await run(normal);
  assert.deepEqual(ok.data.brief.firstToBuild, BRIEF().firstToBuild);
  const { data, runDir, result } = await run(
    normalWith((prompt) => {
      const out = skepticSays()(prompt);
      for (const v of out.verdicts) if (v.id === 'integration-1-1') v.verdict = 'not_on_page';
      return out;
    }),
  );
  assert.deepEqual(data.brief.firstToBuild, [], 'none: research.md says "a person decides"');
  assert.ok(
    data.gaps.includes(
      'firstToBuild: "QuickBooks, because most firms use it" — a cite was not confirmed (integration-1-1); dropped',
    ),
  );
  assert.equal(render(runDir, result).code, 0);
  const md = readFileSync(join(runDir, 'research.md'), 'utf8');
  assert.ok(md.includes('\nFirst to build: a person decides\n'), 'shown to the owner');
});

test("the synthesis's integration columns are the rendered table's, in order", async () => {
  const { calls } = await run(normal);
  const schema = calls.find((c) => c.label === 'synthesis')!.schema;
  const columns = schema.properties.integrations.items.properties.column.enum;
  assert.deepEqual(
    columns,
    COLUMNS.map(([key]: string[]) => key),
  );
  assert.ok(calls.find((c) => c.label === 'synthesis')!.prompt.includes('"integration-2":"Xero"'));
});

test("research.json keeps adoption's ranking; a row only on a confirmed adoption line", async () => {
  // Every integration-2 line fails: its one finding is not on its page.
  const { data, runDir, result } = await run((label, attempt, prompt, dir) => {
    if (label === 'synthesis') {
      const brief = BRIEF();
      brief.integrations.push(
        {
          integration: 'integration-2',
          column: 'adoption',
          text: 'some',
          cites: ['integration-2-1'],
        },
        { integration: 'integration-2', column: 'api', text: 'REST', cites: ['integration-2-1'] },
      );
      return brief;
    }
    if (label !== 'skeptic') return normal(label, attempt, prompt, dir);
    const out = skepticSays()(prompt);
    for (const v of out.verdicts) if (v.id === 'integration-2-1') v.verdict = 'not_on_page';
    return out;
  });
  assert.deepEqual(data.integrations, RANKED);
  assert.ok(!data.brief.integrations.some((l: Any) => l.integration === 'integration-2'));
  assert.equal(render(runDir, result).code, 0);
  const md = readFileSync(join(runDir, 'research.md'), 'utf8');
  assert.match(md, /\n\| QuickBooks \| most firms use it \[adoption-1\] \| .* \| quickbooks \|\n/u);
  assert.ok(!md.includes('| Xero'), 'no confirmed adoption line: no row');
  assert.ok(md.split('## Gaps')[1]!.includes('\n- Xero: ranked by adoption, not confirmed\n'));
});

test('first to build is at most one line: the synthesis schema says so', async () => {
  const { calls } = await run(normal);
  const schema = calls.find((c) => c.label === 'synthesis')!.schema;
  assert.equal(schema.properties.firstToBuild.maxItems, 1);
});

test('a token target too small for the integrations: the stage is skipped, one gap', async () => {
  const r = await run(normal, { total: 100_000 });
  assert.ok(!r.calls.some((c) => c.label.startsWith('integration-')), 'no researcher ran');
  const skipped = r.data.gaps.filter((g: string) => g.startsWith('integrations: the token'));
  assert.deepEqual(skipped, [
    'integrations: the token target is spent before them; 2 not researched',
  ]);
  assert.equal(r.data.stopped, '');
});

test('only an integration researcher\'s "in practice" T4 finding stays: a lens\'s is dropped', async () => {
  const { data, calls } = await run((label, attempt, prompt, dir) => {
    if (label !== 'practice lens') return normal(label, attempt, prompt, dir);
    const out = lensOut('practice');
    out.findings.push(finding('practice', 3, { tier: 'T4', part: 'in practice' }));
    return out;
  });
  assert.ok(data.gaps.includes('practice-3: a tier 4 page, a lead only; dropped'));
  const streamlining = calls.find((c) => c.label === 'streamlining lens')!.prompt;
  assert.ok(!streamlining.includes('practice claim 3'), 'no lead for streamlining');
});

test('the community-report rule is in the researcher and the skeptic prompts', async () => {
  const { calls } = await run(normal);
  const researcher = calls.find((c) => c.label.startsWith('integration-1'))!.prompt;
  assert.ok(
    researcher.includes(
      'only for a finding of part "in practice", a community report, never for a price, a limit or a rule',
    ),
  );
  const skeptic = calls.find((c) => c.label === 'skeptic')!.prompt;
  assert.ok(
    skeptic.includes(
      'A tier T4 quote (a community report) carries only how teams use a product, never a price, a limit or a rule.',
    ),
  );
});

test("the synthesis keys each line by adoption's ranked ids: another name is a gap, never a row", async () => {
  const { data, calls, runDir, result } = await run((label, attempt, prompt, dir) => {
    if (label !== 'synthesis') return normal(label, attempt, prompt, dir);
    const brief = BRIEF();
    brief.integrations.push({
      integration: 'Epic Systems',
      column: 'api',
      text: 'FHIR R4',
      cites: ['integration-1-1'],
    });
    return brief;
  });
  const rows = calls.find((c) => c.label === 'synthesis')!.schema.properties.integrations;
  assert.deepEqual(rows.items.properties.integration.enum, ['integration-1', 'integration-2']);
  const first = calls.find((c) => c.label === 'synthesis')!.schema.properties.firstToBuild;
  assert.deepEqual(first.items.properties.integration.enum, ['integration-1', 'integration-2']);
  assert.ok(
    data.gaps.includes('integrations: "Epic Systems, api: FHIR R4" — not a ranked id; dropped'),
  );
  assert.ok(!data.brief.integrations.some((l: Any) => l.integration === 'Epic Systems'));
  assert.equal(render(runDir, result).code, 0);
  const md = readFileSync(join(runDir, 'research.md'), 'utf8');
  const table = md.split('## Integrations')[1]!.split('\n\nFirst to build')[0]!;
  assert.deepEqual(
    table
      .split('\n')
      .filter((l) => /^\| (?!Integration|---)/u.test(l))
      .map((l) => l.split(' | ')[0]),
    ['| QuickBooks'],
  );
  const none = await run((label, attempt, prompt, dir) =>
    label === 'adoption lens'
      ? { ...lensOut('adoption'), integrations: [] }
      : normal(label, attempt, prompt, dir),
  );
  const empty = none.calls.find((c) => c.label === 'synthesis')!.schema.properties.integrations;
  assert.equal(empty.maxItems, 0, 'no ranking: no integration line');
});

test("adoption's menu is a provider id alone, its path:line apart: a decorated value fails the schema", async () => {
  const { calls, data } = await run(normal);
  const adoption = calls.find((c) => c.label === 'adoption lens')!;
  const ranked = adoption.schema.properties.integrations.items;
  assert.ok(ranked.required.includes('menuAt'));
  const id = new RegExp(ranked.properties.menu.pattern, 'u');
  for (const ok of ['quickbooks', 'to add']) assert.ok(id.test(ok), ok);
  for (const bad of ['quickbooks (platform-menu.json:119)', 'QuickBooks', 'quickbooks '])
    assert.ok(!id.test(bad), bad);
  assert.ok(adoption.prompt.includes('with menu its provider id alone'));
  assert.deepEqual(data.integrations, RANKED, 'research.json keeps menuAt beside the id');
});

for (const child of ['flow-research-integrations.js', 'flow-research-tables.js'])
  test(`a child that does not load (${child}): the documented result, the failure a gap`, async () => {
    const r = await run(normal, { unreadable: child });
    assert.deepEqual(Object.keys(r.result).sort(), [
      'djb2',
      'gaps',
      'length',
      'notResearched',
      'research',
      'sources',
      'stopped',
    ]);
    assert.match(r.result.stopped, /^a step threw \(unreadable scriptPath /u);
    assert.ok(r.result.gaps.some((g: string) => g.startsWith('the run: a step threw (unreadable')));
    assert.equal(r.result.research, join(r.runDir, 'research.json'), 'what it has is written');
    assert.deepEqual(r.data.gaps, r.result.gaps);
    assert.equal(render(r.runDir, r.result).code, 0);
  });
