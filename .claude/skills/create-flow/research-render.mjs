#!/usr/bin/env node
// /create-flow stage 1b: checks <runDir>/research.json against the checksum and length that
// `.claude/workflows/flow-research.js` returned in its Workflow result, then renders research.md
// from the checked file. Nothing a model typed reaches the owner unchecked: a ranked integration is a
// row only while it keeps a confirmed line and confirmed adoption evidence, else a Gaps line (in
// research.md, and first in the summary's gaps); "First to build" only when it names a row.
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

/** Adoption's confirmed findings (`adoption-<n>` ids only, never another finding) whose claim names an
 * entry: its name, or the name in its brackets ("Oracle Health (Cerner)"). */
const naming = (sources, name) => {
  const terms = name.split(/[()]/u).map((t) => t.trim().replace(/[.*+?^${}|[\]\\]/gu, '\\$&'));
  const named = new RegExp(`\\b(?:${terms.filter(Boolean).join('|')})\\b`, 'iu');
  return sources.filter((s) => /^adoption-\d+$/u.test(s.id) && named.test(s.claim ?? ''));
};

/** A finding's own words, never its claim (the skeptic may have dropped the claim's wording, such as
 * a rank): a table-row quote's last cell, else the quote; then its publisher, up to a comma. */
const quoted = (s) => {
  const row = /^\|(.*)\|$/u.exec(s.quote.trim());
  const said = row
    ? row[1]
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .at(-1)
    : `"${s.quote}"`;
  return `${said} (${s.publisher.split(',')[0].trim()})`;
};

/** Adoption's ranking is model text: `integration-<k>` is the k-th entry, a row only while it keeps
 * a confirmed line and its adoption cell (its adoption lines, else the quotes of adoption's findings
 * that name it) is not empty; the rest are Gaps lines. */
const rank = (data) =>
  (data.integrations ?? []).map((r, k) => {
    const id = `integration-${k + 1}`;
    const lines = (data.brief?.integrations ?? []).filter((l) => l.integration === id);
    const own = lines.filter((l) => l.column === 'adoption');
    const adoption = own.length
      ? own
      : naming(data.sources, r.name).map((s) => ({ text: quoted(s), cites: [s.id] }));
    return { ...r, id, lines, adoption, ok: lines.length > 0 && adoption.length > 0 };
  });
const unconfirmed = (ranked) =>
  ranked.filter((r) => !r.ok).map((r) => `${r.name}: ranked by adoption, not confirmed`);
/** "First to build" only when the integration it names is a row. */
const firstOf = (b, rows) => {
  const first = b?.firstToBuild?.[0];
  return first && rows.some((r) => r.id === first.integration) ? first : null;
};

/** One row per confirmed ranked integration, its lines keyed by its id, with their cites. */
function integrations(b, rows, ids) {
  const out = ['## Integrations', ''];
  out.push(`| Integration | ${COLUMNS.map(([, h]) => h).join(' | ')} | On the menu |`);
  out.push(`|---|${COLUMNS.map(() => '---').join('|')}|---|`);
  for (const { name, menu, lines, adoption } of rows) {
    const cells = COLUMNS.map(([key]) => {
      const here = key === 'adoption' ? adoption : lines.filter((l) => l.column === key);
      return here.length ? here.map((l) => `${l.text}${ids(l.cites)}`).join('; ') : 'not found';
    });
    out.push(`| ${[name, ...cells, onMenu.has(menu) ? menu : 'to add'].map(cell).join(' | ')} |`);
  }
  if (!rows.length) out.push('', '- Unknown: nothing confirmed (see Gaps)');
  const first = firstOf(b, rows);
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
  const ranked = rank(data);
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
  for (const g of unconfirmed(ranked)) out.push(`- ${g}`);
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
  const ranked = rank(data);
  const gaps = [...unconfirmed(ranked), ...data.gaps];
  const first = firstOf(
    data.brief,
    ranked.filter((r) => r.ok),
  );
  const counts = HEADINGS.map(([k]) => `${k} ${data.brief?.[k]?.length ?? 0}`).join(', ');
  const lines = [
    `research-render: checksum ok (${sum}); research.md written${data.stopped ? `; STOPPED: ${data.stopped}` : ''}`,
    `lines: ${counts}; integrations ${data.brief?.integrations?.length ?? 0}; first to build: ${first?.text ?? 'a person decides'}; golden cases ${data.brief?.goldenCases?.length ?? 0}; sources ${data.sources.length}`,
    `not researched: ${data.notResearched.length ? data.notResearched.join(' | ') : 'none'}`,
    `gaps (${gaps.length}): ${gaps.join(' | ')}`,
  ];
  write(`${lines.join('\n').slice(0, 2000)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
