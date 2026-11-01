#!/usr/bin/env node
// /create-flow stage 1b: checks <runDir>/research.json against the checksum and length that
// `.claude/workflows/flow-research.js` returned in its Workflow result, then renders research.md
// from the checked file. Nothing a model typed reaches the owner unchecked: a ranked integration is a
// row only while its adoption column keeps a confirmed line, else a Gaps line.
//   node research-render.mjs <runDir>/research.json <djb2> <length>
// Exit 0: research.md written beside it, a summary of 2 KB or less printed. Exit 1: a mismatch or
// no readable file (re-run the workflow with resumeFromRunId and args.writeAttempt = 2). Exit 2:
// usage. It re-serializes the file (JSON.stringify(JSON.parse(…))), so whitespace is not a
// mismatch and a changed word is. djb2 is not a security hash: it catches a model's retyping,
// which is all it is for. Node built-ins only.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The same djb2 the workflow computes over the exact text it hands the write. */
export const djb2 = (text) => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
};

const HEADINGS = [
  ['process', 'How the work runs today, end to end'],
  ['waste', 'Where the time and the errors go'],
  ['criteria', 'What an expert checks'],
  ['rubric', 'The rubric'],
  ['rules', 'The rules that bind a result'],
  ['v1', 'The simplest first version'],
  ['failures', 'When it goes wrong'],
];

/** The Integrations table's columns, in the order of the synthesis schema (flow-research-tables.js). */
export const COLUMNS = [
  ['adoption', 'Adoption'],
  ['api', 'API / MCP'],
  ['signIn', 'Sign-in'],
  ['events', 'Events and write-back'],
  ['cost', 'Cost'],
  ['constraints', 'Constraints'],
  ['concerns', 'Concerns'],
  ['practice', 'In practice'],
];
// "On the menu" is checked here, never written by a model: adoption's menu value when it is exactly
// a provider id the menu lists, else "to add" (no finding can quote an absence).
const MENU = join(import.meta.dirname, '../../../contract/schemas/platform-menu.json');
const onMenu = new Set(JSON.parse(readFileSync(MENU, 'utf8')).providers.map((p) => p.id));
const cell = (text) => text.replaceAll('|', '\\|');

/** Adoption's ranking is model text: an entry is a row only while its adoption column keeps a
 * line the skeptic's gate let stand; the rest are listed under Gaps. */
const rank = (b, ranked) =>
  ranked.map((r, k) => {
    const id = `integration-${k + 1}`;
    const ok = (b?.integrations ?? []).some((l) => l.integration === id && l.column === 'adoption');
    return { ...r, id, ok };
  });

/** One row per confirmed ranked integration, its lines keyed by its id, with their cites. */
function integrations(b, ranked, ids) {
  const lines = b?.integrations ?? [];
  const out = ['## Integrations', ''];
  out.push(`| Integration | ${COLUMNS.map(([, h]) => h).join(' | ')} | On the menu |`);
  out.push(`|---|${COLUMNS.map(() => '---').join('|')}|---|`);
  for (const { id, name, menu } of ranked) {
    const cells = COLUMNS.map(([key]) => {
      const here = lines.filter((l) => l.integration === id && l.column === key);
      return here.length ? here.map((l) => `${l.text}${ids(l.cites)}`).join('; ') : 'not found';
    });
    out.push(`| ${[name, ...cells, onMenu.has(menu) ? menu : 'to add'].map(cell).join(' | ')} |`);
  }
  if (!ranked.length) out.push('', '- Unknown: nothing confirmed (see Gaps)');
  const first = b?.firstToBuild?.[0];
  out.push('', `First to build: ${first ? first.text + ids(first.cites) : 'a person decides'}`, '');
  return out;
}

/** An open question: its default and ids, or "not researched" with the proposal the owner may keep. */
function question(q, ids) {
  if (q.researched) return `- ${q.question} — default: ${q.proposedDefault}${ids(q.cites)}`;
  const kept =
    q.proposal && q.proposal !== q.proposedDefault
      ? `; proposed "${q.proposal}", kept only if the owner says so`
      : '';
  return `- ${q.question} — default: ${q.proposedDefault} (not researched${kept})`;
}

/** research.md from the checked research.json (the design's §4 headings, in order). */
export function render(data) {
  const ids = (cites) => ` [${cites.join(', ')}]`;
  const out = [`# ${data.name}: domain brief`, ''];
  if (data.stopped) out.push(`**Stopped: ${data.stopped}.**`, '');
  if (data.framing) {
    out.push("## The owner's words (not researched)", '');
    for (const f of ['job', 'decision', 'goodResult'])
      out.push(`- ${f}: ${data.framing[f] ? `"${data.framing[f]}"` : 'not stated'}`);
    out.push('');
  }
  const b = data.brief;
  const ranked = rank(b, data.integrations ?? []);
  const rows = ranked.filter((r) => r.ok);
  for (const [key, heading] of HEADINGS) {
    out.push(`## ${heading}`, '');
    for (const l of b?.[key] ?? []) out.push(`- ${l.text}${ids(l.cites)}`);
    if (!(b?.[key] ?? []).length) out.push('- Unknown: nothing confirmed (see Gaps)');
    out.push('');
    if (key === 'rules') out.push(...integrations(b, rows, ids));
  }
  out.push('## Golden cases (invented data)', '');
  for (const c of b?.goldenCases ?? []) out.push(`- ${c.input} → ${c.expected}${ids(c.cites)}`);
  out.push('', '## Open questions', '');
  for (const q of b?.openQuestions ?? []) out.push(question(q, ids));
  out.push('', '## Gaps', '');
  for (const g of data.gaps) out.push(`- ${g}`);
  for (const { name } of ranked.filter((r) => !r.ok))
    out.push(`- ${name}: ranked by adoption, not confirmed`);
  out.push(
    '',
    '## Sources',
    '',
    '| Id | Tier | Publisher | URL | The exact quote |',
    '|---|---|---|---|---|',
  );
  for (const s of data.sources)
    out.push(
      `| ${s.id} | ${s.tier === 'T4' ? 'T4, community report' : s.tier} | ${s.publisher} | ${s.url} | "${cell(s.quote)}" |`,
    );
  return `${out.join('\n')}\n`;
}

export function main([path, expected, length], write = (t) => process.stdout.write(t)) {
  if (!path || !expected || !length)
    return (write('usage: research-render.mjs <research.json> <djb2> <length>\n'), 2);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return (write(`research-render: ${path} is not readable JSON (${error.message})\n`), 1);
  }
  const text = JSON.stringify(data);
  const sum = djb2(text);
  if (sum !== expected || String(text.length) !== String(length)) {
    write(
      `research-render: MISMATCH — ${path} is djb2 ${sum} length ${text.length}, the workflow returned ${expected} length ${length}\n`,
    );
    return 1;
  }
  writeFileSync(join(dirname(path), 'research.md'), render(data));
  const counts = HEADINGS.map(([k]) => `${k} ${data.brief?.[k]?.length ?? 0}`).join(', ');
  const lines = [
    `research-render: checksum ok (${sum}); research.md written${data.stopped ? `; STOPPED: ${data.stopped}` : ''}`,
    `lines: ${counts}; integrations ${data.brief?.integrations?.length ?? 0}; first to build: ${data.brief?.firstToBuild?.[0]?.text ?? 'a person decides'}; golden cases ${data.brief?.goldenCases?.length ?? 0}; sources ${data.sources.length}`,
    `not researched: ${data.notResearched.length ? data.notResearched.join(' | ') : 'none'}`,
    `gaps (${data.gaps.length}): ${data.gaps.join(' | ')}`,
  ];
  write(`${lines.join('\n').slice(0, 2000)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
