export const meta = {
  name: 'flow-research-integrations',
  description:
    "flow-research.js's integrations stage: the adoption lens, then one researcher per integration it ranks, at most three at once; it is never run alone.",
  whenToUse:
    'Never directly: flow-research.js runs it once by workflow({ scriptPath }, { T, adoption, integration }).',
  phases: [
    { title: 'Lenses', detail: 'the adoption lens: at most five integrations, ranked' },
    { title: 'Integrations', detail: 'a researcher per ranked integration, three at once' },
  ],
};

// The integrations stage of `.claude/workflows/flow-research.js` (the line ceiling), run after
// practice, streamlining and rules, so at most MAX_AGENTS run at once. args: T, the tables
// (a child cannot call workflow()); adoption, the adoption lens's prompt; integration, the
// researcher's prompt with "<lens>" and "<product>" to fill. It returns { results, ranked, gaps }:
// each result's findings numbered `<lens>-<n>` here, never by the model; the main script gates them.
const { T, adoption: adoptionPrompt, integration } = args ?? {};
if (!T || !adoptionPrompt || !integration)
  throw new Error('needs args { T, adoption, integration }');
const { MAX_AGENTS, MAX_INTEGRATIONS, CAP, NEED, SCHEMA, NOTHING } = T;
const gaps = [];

const message = (error) => String(error?.message ?? error).slice(0, 200);
/** One call; a throw is a failure, never the end of the run (as flow-research.js's). */
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
async function once(label, run) {
  const first = await attempt(run, '');
  if (first.out?.findings.length) return first.out;
  const why = failure(first);
  log(`${label}: ${why}; one retry`);
  const second = await attempt(
    run,
    `An earlier attempt failed (${why}). Try a different way. ${NOTHING}`,
  );
  if (second.out?.findings.length) return second.out;
  const notFound = (second.out?.notFound ?? []).join('; ');
  const looked = notFound && `; looked for: ${notFound}`;
  gaps.push(`${label}: failed twice (${why}; then ${failure(second)}); not researched${looked}`);
  return null;
}
async function research(lens, product, prompt, schema, phase) {
  const label = product ? `${lens} lens (${product})` : `${lens} lens`;
  const call = (extra) =>
    agent(`${extra}${prompt}`, { phase, label, agentType: 'researcher', schema });
  const out = await once(label, call);
  if (out?.toolCalls > CAP.broad) log(`${label}: ${out.toolCalls} tool calls, cap ${CAP.broad}`);
  const findings = out?.findings.map((f, i) => ({ ...f, id: `${lens}-${i + 1}` }));
  return out ? { lens, label, ...out, findings } : null;
}

const adoption = await research('adoption', null, adoptionPrompt, SCHEMA.ADOPTION, 'Lenses');
const all = adoption?.integrations ?? [];
for (const i of all.slice(MAX_INTEGRATIONS))
  gaps.push(`adoption: "${i.name}" past the cap of ${MAX_INTEGRATIONS}; not researched`);
const ranked = all.slice(0, MAX_INTEGRATIONS);
const results = [adoption];
const fits = !budget.total || budget.remaining() > NEED.integrations;
if (ranked.length && !fits)
  gaps.push(`integrations: the token target is spent before them; ${ranked.length} not researched`);
else if (ranked.length) phase('Integrations');
for (let k = 0; fits && k < ranked.length; k += MAX_AGENTS) {
  const batch = ranked.slice(k, k + MAX_AGENTS).map(({ name }, j) => () => {
    const lens = `integration-${k + j + 1}`;
    const prompt = integration.replaceAll('<lens>', lens).replaceAll('<product>', name);
    return research(lens, name, prompt, SCHEMA.INTEGRATION_FINDINGS, 'Integrations');
  });
  results.push(...(await parallel(batch)));
}
return { results: results.filter(Boolean), ranked, gaps };
