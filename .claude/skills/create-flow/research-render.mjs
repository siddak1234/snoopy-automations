#!/usr/bin/env node
// /create-flow stage 1b: checks <runDir>/research.json against the checksum and length that
// `.claude/workflows/flow-research.js` returned in its Workflow result, then renders research.md
// from the checked file. Nothing a model typed reaches the owner unchecked.
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
  ['vendors', 'Vendors and our providers'],
  ['v1', 'The simplest first version'],
  ['failures', 'When it goes wrong'],
];

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
  for (const [key, heading] of HEADINGS) {
    out.push(`## ${heading}`, '');
    for (const l of b?.[key] ?? []) out.push(`- ${l.text}${ids(l.cites)}`);
    if (!(b?.[key] ?? []).length) out.push('- Unknown: nothing confirmed (see Gaps)');
    out.push('');
  }
  out.push('## Golden cases (invented data)', '');
  for (const c of b?.goldenCases ?? []) out.push(`- ${c.input} → ${c.expected}${ids(c.cites)}`);
  out.push('', '## Open questions', '');
  for (const q of b?.openQuestions ?? []) out.push(question(q, ids));
  out.push('', '## Gaps', '');
  for (const g of data.gaps) out.push(`- ${g}`);
  out.push(
    '',
    '## Sources',
    '',
    '| Id | Tier | Publisher | URL | The exact quote |',
    '|---|---|---|---|---|',
  );
  for (const s of data.sources)
    out.push(
      `| ${s.id} | ${s.tier} | ${s.publisher} | ${s.url} | "${s.quote.replaceAll('|', '\\|')}" |`,
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
    `lines: ${counts}; golden cases ${data.brief?.goldenCases?.length ?? 0}; sources ${data.sources.length}`,
    `not researched: ${data.notResearched.length ? data.notResearched.join(' | ') : 'none'}`,
    `gaps (${data.gaps.length}): ${data.gaps.join(' | ')}`,
  ];
  write(`${lines.join('\n').slice(0, 2000)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
