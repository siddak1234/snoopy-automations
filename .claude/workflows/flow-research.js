export const meta = {
  name: 'flow-research',
  description:
    "Research one flow idea before its spec: the owner's words, four lenses, one researcher per integration the adoption lens ranks (at most three agents at once), one synthesis, one skeptic, research.json (/create-flow stage 1b).",
  whenToUse:
    'After /create-flow stage 1 (the platform check and the decisions); pass args { runDir, automations, name, idea, answers, platform, backend?, writeAttempt? }; no backend clone is needed: the adoption lens reads the menu in contract/schemas.',
  phases: [
    { title: 'Frame', detail: "the owner's words, quoted; the lens questions; no research" },
    { title: 'Lenses', detail: 'practice then streamlining, and rules, at once' },
    { title: 'Integrations', detail: 'flow-research-integrations.js: adoption, then its ranking' },
    { title: 'Synthesis', detail: 'the domain brief from the findings only' },
    { title: 'Skeptic', detail: 'one retry: every cited page re-opened, every line judged' },
    { title: 'Write', detail: 'research.json exactly as computed; its checksum returned' },
  ],
};

// /create-flow stage 1b. Source tags (URLs: create-flow/research-stage.md, Sources): A1 multi-agent
// research system, A2 Building effective agents, A3 Reduce hallucinations, A5 Demystifying evals,
// O1 OpenAI's guide to agents, O2 OpenAI deep research, WF the Workflow tool's reference. API
// retries are the harness's (agent() is null only "after retries", WF); ours is once()'s, one. A
// write that failed its checksum re-runs through resumeFromRunId with writeAttempt = 2 (only its
// prompt changes). The checksum, the stops and the gaps are the return value: the Workflow tool
// hands the session the top-level return; log() lines do not reach it. `node --check` refuses it,
// so test/flow-research.ts compiles this file and its two children as the harness runs them.
const { runDir, automations, backend, name, idea, answers, platform } = args ?? {};
const writeAttempt = args?.writeAttempt ?? 1;
const needs = 'flow-research needs args { runDir, automations, name, idea, answers }';
if (!runDir || !automations || !name || !idea) throw new Error(needs);
// Two children beside this file, each run once in the try (one level, the harness's limit).
const child = (file) => ({ scriptPath: `${automations}/.claude/workflows/${file}` });
let T, LENS, DATA, SCHEMA, CAP, NEED, MAX_FINDINGS, MAX_QUESTIONS, LENSES, ALL;
const PERSON = 'a person decides'; // O1: "escalate to human intervention"
const gaps = [];
let gapsLogged = false;
let stopped = '';
/** A gap goes to research.json and the result; after the gap log has run, it is logged at once. */
const gap = (text) => (gaps.push(text), gapsLogged && log(`gap: ${text}`));
/** A stop is logged where it happens and joined to any earlier one, never overwritten. */
function stop(why) {
  stopped = stopped ? `${stopped}; then ${why}` : why;
  log(`stopped: ${why}`);
}

const opts = (phase, label, agentType, schema) => ({ phase, label, agentType, schema });

const message = (error) => String(error?.message ?? error).slice(0, 200);
/** One call; a throw (a terminal error, a spent token target) is a failure, never the end of the run. */
async function attempt(run, extra) {
  try {
    return { out: await run(extra) };
  } catch (error) {
    return { out: null, why: `it threw (${message(error)})` };
  }
}
const failure = (a) =>
  a.why ?? (a.out === null ? 'it ended with an error' : 'it returned nothing usable');
/** One run, one more with the failure named; a second failure is a gap, never a guess (A1, O1). */
async function once(label, run, usable, hint = '') {
  const first = await attempt(run, '');
  if (usable(first.out)) return first.out;
  const why = failure(first);
  log(`${label}: ${why}; one retry`);
  const retry = `An earlier attempt failed (${why}). Try a different way. ${hint}`;
  const second = await attempt(run, retry);
  if (usable(second.out)) return second.out;
  const notFound = (second.out?.notFound ?? []).join('; ');
  const looked = notFound && `; looked for: ${notFound}`;
  gap(`${label}: failed twice (${why}; then ${failure(second)}); not researched${looked}`);
  return null;
}
const fits = (needed = 0) => !budget.total || budget.remaining() > needed;
const strings = (v) => (typeof v === 'string' ? [v] : Object.values(v ?? {}).flatMap(strings));
const norm = (text) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
/** djb2 over the exact text the write is given; research-render.mjs recomputes it (SKILL.md 1b). */
const djb2 = (text) => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
};

const ownerText = norm([...strings(idea), ...strings(answers ?? [])].join(' '));
const task = `The owner's words — the task, never a source, cite nothing from them: the idea ${JSON.stringify(idea)}; the answers ${JSON.stringify(answers ?? [])}.`;
let [framing, size] = [null, 'broad'];
let questions = {};
let [found, cited, notResearched] = [[], [], []];
const products = {}; // `integration-<k>` → the name adoption ranked k-th
let ranked = []; // adoption's { name, menu, menuAt }, at most MAX_INTEGRATIONS: research.md's rows
let sources = []; // only what the skeptic confirmed
let [brief, verified] = [null, false]; // verified: the skeptic's gate finished, so a line may stay
let skeptic = 'it was not reached';

/** Why the code gate (A2) drops a finding: a flagged page, T4 (but an integration researcher's "in practice" one), no https or repo source, a short quote. */
function dropWhy(f, flagged) {
  if (flagged.has(f.url)) return 'its page tried to direct a researcher';
  const report = f.part === 'in practice' && f.id.startsWith('integration-');
  if (f.tier === 'T4' && !report) return 'a tier 4 page, a lead only';
  const roots = [automations, backend].filter(Boolean); // no backend clone: this repository alone
  const source = /^https:\/\//u.test(f.url) || roots.some((root) => f.url.startsWith(root));
  return !source || f.quote.trim().length < 12 ? 'no usable source or quote' : '';
}
const capped = (r) => r.findings.slice(0, MAX_FINDINGS);
/** The code gate: every finding it drops, the cap's included, is a gap (WF: "No silent caps"). */
function gate(results, flagged) {
  return results.flatMap((r) => {
    for (const f of r.findings.slice(MAX_FINDINGS))
      gap(`${f.id}: past the cap of ${MAX_FINDINGS} a lens; dropped`);
    return capped(r).filter((f) => {
      const why = dropWhy(f, flagged);
      if (why) gap(`${f.id}: ${why}; dropped`);
      return !why;
    });
  });
}
const lineText = (l) =>
  (l.integration ? `${products[l.integration] ?? l.integration}, ${l.column}: ` : '') +
  (l.text ?? l.question ?? `${l.input} → ${l.expected}`);

try {
  T = await workflow(child('flow-research-tables.js'), { automations });
  ({ LENS, DATA, SCHEMA, CAP, NEED, MAX_FINDINGS, MAX_QUESTIONS } = T);
  LENSES = Object.keys(LENS);
  ALL = [...T.SECTIONS, 'integrations', 'firstToBuild', 'goldenCases'];
  questions = Object.fromEntries(LENSES.map((l) => [l, []]));
  phase('Frame');
  if (!fits(NEED.frame)) stop('the token target is spent before the frame');
  const lensList = LENSES.map((l) => `${l} (${LENS[l][0]})`).join('; ');
  const framePrompt = (extra) =>
    `${extra}Frame the research for the flow "${name}". Do no research and open no web page. ${task} The platform check: ${JSON.stringify(platform ?? '')}. ` +
    `ownerWords: copy, word for word, the owner's own sentence that names the job, the decision the flow helps make, and what a good result is; an empty string where the owner did not say it — never your words. ` +
    `Size: simple (one kind of document, one decision) or broad. questions: for each lens, the questions this idea raises, at most ${MAX_QUESTIONS} a lens, the ones that decide the build first, so a lens fits its tool calls — everything you would otherwise assume about the job goes here as a question. The lenses: ${lensList}.`;
  const frame = stopped
    ? null
    : await once(
        'frame',
        (extra) => agent(framePrompt(extra), opts('Frame', 'frame', 'explorer', SCHEMA.FRAME)),
        (out) => Boolean(out?.questions && LENSES.every((l) => Array.isArray(out.questions[l]))),
      );
  if (frame) {
    // The frame states only the owner's words: a field not found word for word in the idea or the
    // answers is dropped, and its question goes to a lens (O2: clarify, do not research).
    framing = { note: "the owner's words, quoted; not researched" };
    for (const field of ['job', 'decision', 'goodResult']) {
      const quote = frame.ownerWords[field].trim();
      const said = quote.length > 0 && ownerText.includes(norm(quote));
      framing[field] = said ? quote : null;
      if (quote && !said)
        gap(`framing: the ${field} "${quote}" is not the owner's words; dropped, asked of a lens`);
    }
    size = frame.size;
    questions = frame.questions;
    const ask = (l, q) => questions[l].unshift(q); // the script's own go first, kept by the cap
    if (!framing.goodResult) ask('practice', 'What does an expert count as a good result?');
    if (!framing.decision) ask('practice', 'Which decision does this work exist to make?');
    if (!framing.job) ask('streamlining', 'Who does this job today, and what do they call it?');
    for (const l of LENSES)
      for (const q of questions[l].splice(MAX_QUESTIONS)) gap(`${l}: "${q}" past the cap; dropped`);
  } else if (!stopped) stop('the frame failed twice');

  if (frame && !stopped && !fits(NEED.lenses)) stop('the token target is spent before the lenses');
  if (frame && !stopped) {
    phase('Lenses');
    // product: the integration researcher's, its "<lens>" and "<product>" filled by the stage.
    const lensPrompt = (lens, product, cap, leads, extra) => {
      const [objective, sources, notJob, t4] = product ? T.INTEGRATION : [...LENS[lens], T.T4];
      const asked = product ? '' : `Questions: ${JSON.stringify(questions[lens])}. `;
      const given = leads
        ? `The practice lens found these (leads only: re-open any you build on and cite your own fetch): ${JSON.stringify(leads.map(({ claim, url }) => ({ claim, url })))}. `
        : '';
      return (
        `${extra}Research one ${product ? 'integration' : 'lens'} of the flow "${name}": ${lens}. ${task} Objective: ${objective}. ${asked}Sources: ${sources}. Not your job: ${notJob}. ${given}` +
        `At most ${cap} tool calls and ${MAX_FINDINGS} findings. Search short and broad, then narrow; prefer T1 (regulator, statute, standards body, the vendor's own docs, our repos by path:line) and T2 (professional bodies, practitioner standards, named experts); T3 only reporting on those; ${t4}. ` +
        `Skip a very long page (a whole code set, a full manual) for a small specific one. Each finding: one claim, the URL you fetched, one exact sentence from that page copied character for character (a paraphrase is dropped), its tier and publisher. Use only what you fetched in this task, never memory; a figure, a price or a limit with no page is "not found". ${backend === undefined ? `${automations} is` : `${automations} and ${backend} are`} read-only. ${DATA}`
      );
    };
    const runLens = (lens, leads = null) => {
      const label = `${lens} lens`;
      const cap = CAP[size] ?? CAP.broad;
      return once(
        label,
        (extra) =>
          agent(
            lensPrompt(lens, false, cap, leads, extra),
            opts('Lenses', label, 'researcher', SCHEMA.FINDINGS),
          ),
        (out) => Boolean(out && out.findings.length > 0),
        T.NOTHING,
      ).then((out) => {
        if (out?.toolCalls > cap) log(`${label}: ${out.toolCalls} tool calls, cap ${cap}`);
        // Ids are the script's, `<lens>-<n>` by position, never the model's: no two are the same.
        const findings = out?.findings.map((f, i) => ({ ...f, id: `${lens}-${i + 1}` }));
        return out ? { lens, label, ...out, findings } : null;
      });
    };
    // Two slots: practice then streamlining (a chain, A2: "each LLM call processes the output of the
    // previous one"), and rules. The leads are filtered without recording: the one gate below does.
    const slots = await parallel([
      async () => {
        const practice = await runLens('practice');
        const flaggedHere = new Set(practice?.injectionSeen ?? []);
        const leads = practice ? capped(practice).filter((f) => !dropWhy(f, flaggedHere)) : null;
        return [practice, await runLens('streamlining', leads)];
      },
      async () => [await runLens('rules')],
    ]);
    const lensesDone = slots.flatMap((slot) => slot ?? []).filter(Boolean);
    // Then the integrations stage, MAX_AGENTS at once (the other lenses are done), unless two failed.
    const stage =
      lensesDone.length < 2
        ? null
        : await workflow(child('flow-research-integrations.js'), {
            T,
            adoption: lensPrompt('adoption', false, CAP.broad, null, ''),
            integration: lensPrompt('<lens>', true, CAP.broad, null, ''),
          });
    for (const g of stage?.gaps ?? []) gap(g);
    lensesDone.push(...(stage?.results ?? []));
    ranked = stage?.ranked ?? [];
    ranked.forEach((i, k) => (products[`integration-${k + 1}`] = i.name));
    const ran = (l) => l !== 'adoption' || stage;
    const failed = LENSES.filter((l) => ran(l) && !lensesDone.some((r) => r.lens === l));
    // Half the angles missing is not the depth the owner asked for: two failed lenses stop the run.
    if (failed.length >= 2) stop(`${failed.length} of 4 lenses failed (${failed.join(', ')})`);
    const flagged = new Set(lensesDone.flatMap((r) => r.injectionSeen));
    if (flagged.size) log(`pages that tried to direct a researcher: ${[...flagged].join(' ')}`);
    found = gate(lensesDone, flagged);
    for (const r of lensesDone) for (const n of r.notFound) gap(`${r.label}, not found: ${n}`);
  }
  if (frame && !stopped && !fits(NEED.synthesis))
    stop('the token target is spent before the synthesis');
  if (frame && !stopped) {
    phase('Synthesis');
    const synthesisPrompt = (extra) =>
      `${extra}Write the domain brief for the flow "${name}" from these findings only — no memory, no web: ${JSON.stringify(found)}. ${task} ` +
      `Fill: process (today's work end to end: who, what goes in, what comes out); waste (where the time and the errors go); criteria (what an expert checks, in order); rubric (the criteria as the flow will score or decide them); rules (what binds a result, the model vendors' rules on our own AI calls included); ` +
      `integrations: for each integration the adoption lens ranked, its id from ${JSON.stringify(products)} (no other name), lines by column — adoption (its evidence), api (the API, any MCP server, the SDKs), signIn, events (events and write-back), cost, constraints, concerns, practice (how teams integrate it) — a tier T4 finding (a community report) cited only by a practice line; firstToBuild: one line "X, because …" citing the findings that separate it, or none when they do not (${PERSON}); ` +
      `v1 (the simplest pipeline: what is automated, what stays with a person, what is left out — few steps, few questions); failures (when it goes wrong); 5 to 10 golden cases with invented inputs only (example.com for any link) and the expected result; open questions. ` +
      `Every line cites the finding ids it rests on; a line no finding carries is not written — it becomes an open question. An open question is kind domain_fact (its default states something about the job, the rules or a vendor) or our_choice (a product choice); a default with no finding is "${PERSON}".`;
    const BRIEF = JSON.parse(JSON.stringify(SCHEMA.BRIEF)); // rows: adoption's ranked ids only
    const rows = BRIEF.properties.integrations;
    const ids = Object.keys(products);
    if (ids.length) rows.items.properties.integration = { type: 'string', enum: ids };
    else rows.maxItems = 0;
    brief = await once(
      'synthesis',
      (extra) => agent(synthesisPrompt(extra), opts('Synthesis', 'synthesis', 'explorer', BRIEF)),
      (out) => Boolean(out && out.process.length > 0 && out.criteria.length > 0),
    );
    if (!brief) stop('the synthesis failed twice');
  }
  if (brief) {
    // The code gate (A2): a cite to an id no lens returned is no cite; a line with none is a gap.
    const ids = new Set(found.map((f) => f.id));
    // A T4 finding (a community report) carries only an "in practice" line: any other cite of one goes.
    const t4 = new Set(found.filter((f) => f.tier === 'T4').map((f) => f.id));
    const keep = (s) => (l) => {
      const lead = (id) => t4.has(id) && l.column !== 'practice';
      for (const id of l.cites.filter(lead))
        gap(`${s}: "${lineText(l)}" — ${id} is T4; cite dropped`);
      return { ...l, cites: l.cites.filter((id) => ids.has(id) && !lead(id)) };
    };
    for (const l of brief.integrations)
      if (!products[l.integration])
        gap(`integrations: "${lineText(l)}" — not a ranked id; dropped`);
    brief.integrations = brief.integrations.filter((l) => products[l.integration]);
    for (const s of ALL) {
      brief[s] = brief[s].map(keep(s));
      for (const l of brief[s])
        if (!l.cites.length) gap(`${s}: "${lineText(l)}" — no source; dropped`);
      brief[s] = brief[s].filter((l) => l.cites.length > 0);
    }
    brief.openQuestions = brief.openQuestions.map(keep('openQuestions'));
    const citing = [...ALL.flatMap((s) => brief[s]), ...brief.openQuestions];
    cited = found.filter((f) => citing.some((l) => l.cites.includes(f.id)));
    const byId = new Map(found.map((f) => [f.id, f]));
    const quoted = (cites) => cites.map((id) => ({ id, quote: byId.get(id).quote }));
    // Every line, golden case and cited open-question default goes to the skeptic with its quotes.
    const lines = ALL.flatMap((s) =>
      brief[s].map((l, i) => ({ ref: `${s}.${i}`, text: lineText(l), cites: quoted(l.cites) })),
    );
    for (const [i, q] of brief.openQuestions.entries()) {
      const text = `${q.question} — default: ${q.proposedDefault}`;
      if (q.cites.length) lines.push({ ref: `openQuestions.${i}`, text, cites: quoted(q.cites) });
    }

    let verdicts = null;
    if (!fits(NEED.skeptic)) skeptic = 'the token target was spent before it';
    else if (cited.length === 0) verdicts = { verdicts: [], lines: [], injectionSeen: [] };
    else {
      phase('Skeptic');
      skeptic = 'it failed twice';
      const checks = cited.map(({ id, claim, url, quote }) => ({ id, claim, url, quote }));
      const skepticPrompt = (extra) =>
        `${extra}Check each finding once. For each, open its URL (a repo path: read the file) and answer confirmed only if the quote is on the page word for word and it carries the claim; not_on_page if the words are not there; does_not_support if they are there but do not carry the claim; unknown if the page will not open or you cannot tell. ` +
        `Then judge each line against the quotes it cites: supported only if those quotes carry everything the line says (a weight, a figure, an order, an expected result, a default included); not_supported if the line says more than its quotes; unknown when you cannot tell. A tier T4 quote (a community report) carries only how teams use a product, never a price, a limit or a rule. ` +
        `Default to unknown when unsure. Do not search for other pages and do not fix a claim or a line. ${DATA} Findings: ${JSON.stringify(checks)} Lines: ${JSON.stringify(lines)}`;
      verdicts = await once(
        'skeptic',
        (extra) =>
          agent(skepticPrompt(extra), opts('Skeptic', 'skeptic', 'researcher', SCHEMA.VERDICTS)),
        (out) => Boolean(out && out.verdicts.length > 0),
      );
    }
    if (verdicts) skeptic = '';
    else stop(`the skeptic did not finish (${skeptic}); no claim is verified`);
    // The code gate (A2), each verdict counted: a finding stays when all its verdicts say confirmed
    // on a page that did not direct the skeptic; a line, when its cites stand and all say supported.
    const misled = new Set(verdicts?.injectionSeen ?? []);
    if (misled.size) log(`pages that tried to direct the skeptic: ${[...misled].join(' ')}`);
    const against = (all, key, at, good, single = '') => {
      const vs = all.filter((v) => v[key] === at);
      const bad = vs.filter((v) => v.verdict !== good).map((v) => `${v.verdict} — ${v.why}`);
      const many = vs.length > 1 ? `the skeptic gave ${vs.length} verdicts, ` : single;
      return vs.length ? (bad.length ? many + bad.join('; ') : '') : `${single}no verdict`;
    };
    const confirmed = new Set();
    for (const { id, url } of verdicts ? cited : []) {
      const why = against(verdicts.verdicts, 'id', id, 'confirmed');
      if (misled.has(url)) gap(`${id}: its page tried to direct the skeptic`);
      else if (why) gap(`${id}: ${why}`);
      else confirmed.add(id);
    }
    const unsupported = (ref, cites) => {
      const unconfirmed = cites.filter((id) => !confirmed.has(id));
      if (unconfirmed.length === cites.length) return 'Unknown, not verified';
      if (unconfirmed.length) return `a cite was not confirmed (${unconfirmed.join(', ')})`;
      return against(verdicts.lines, 'ref', ref, 'supported', 'the skeptic: ');
    };
    for (const s of ALL)
      brief[s] = brief[s].flatMap((l, i) => {
        const why = unsupported(`${s}.${i}`, l.cites);
        if (why) gap(`${s}: "${lineText(l)}" — ${why}; dropped`);
        return why ? [] : [l];
      });
    // Open questions: a default stands as a line does; any other, of either kind, is "a person
    // decides" unless the owner keeps the proposal, and is listed for the owner as not researched.
    brief.openQuestions = brief.openQuestions.map((q, i) => {
      const researched = q.cites.length > 0 && !unsupported(`openQuestions.${i}`, q.cites);
      if (researched) return { ...q, researched };
      return { ...q, cites: [], proposedDefault: PERSON, proposal: q.proposedDefault, researched };
    });
    const keepIt = (q) => (q.proposal !== PERSON ? `, unless the owner keeps "${q.proposal}"` : '');
    notResearched = brief.openQuestions
      .filter((q) => !q.researched)
      .map((q) => `${q.question} (${q.kind}, not researched): ${PERSON}${keepIt(q)}`);
    sources = found.filter((f) => confirmed.has(f.id));
    verified = true;
  }
} catch (error) {
  // A throw outside an agent call: the run stops; what it has is written, but no unverified line.
  gap(`the run: a step threw (${message(error)}); it stopped there`);
  stop(`a step threw (${message(error)})`);
  for (const s of brief && !verified ? [...ALL, 'openQuestions'] : [])
    for (const l of [brief[s] ?? []].flat())
      gap(`${s}: "${lineText(l ?? {})}" — not verified; the run stopped`);
  if (!verified) brief = null;
}

// The write: every gap is logged first, so the session has them even when no file is written.
phase('Write');
for (const g of gaps) log(`gap: ${g}`);
gapsLogged = true;
const notRun = skeptic === 'it was not reached' ? 'did not run' : `did not finish (${skeptic})`;
const left = skeptic
  ? `the skeptic ${notRun}: none of the ${found.length} gated findings is verified`
  : `${cited.length - sources.length} cited findings not confirmed by the skeptic, ${found.length - cited.length} not cited by the brief: left out of research.json`;
if (found.length > sources.length) log(left);
const payload = {
  name,
  framing,
  brief,
  integrations: ranked,
  sources,
  gaps,
  notResearched,
  stopped,
};
const text = JSON.stringify(payload);
const checksum = djb2(text);
log(`research.json: djb2 ${checksum} length ${text.length}`);
let written = null;
if (!fits(NEED?.write)) stop('the token target is spent; research.json was not written');
else {
  const again = writeAttempt > 1 ? `Attempt ${writeAttempt}: a file failed its checksum. ` : '';
  const writePrompt = (extra) =>
    `${extra}${again}Write ${runDir}/research.json with one Write call whose whole content is exactly the text between the markers, unchanged: no reformatting, no reordering, no rewording. Then return that path and nothing else.\n<<<JSON\n${text}\nJSON>>>`;
  const writer = { label: 'write', phase: 'Write', agentType: 'builder', model: 'sonnet' };
  written = await once(
    'write',
    (extra) => agent(writePrompt(extra), { ...writer, effort: 'low' }),
    (out) => typeof out === 'string' && out.includes('research.json'),
  );
  if (!written) stop('research.json was not written');
}
const done = stopped ? `stopped (${stopped})` : 'done';
log(`research: ${done}; ${sources.length} sources; ${gaps.length} gaps; djb2 ${checksum}`);
const research = written ? `${runDir}/research.json` : null;
const result = { research, djb2: checksum, length: text.length, stopped, gaps, notResearched };
return { ...result, sources: sources.length };
