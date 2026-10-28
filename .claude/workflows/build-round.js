export const meta = {
  name: 'build-round',
  description:
    'Build one round across up to three repository clones: design, lanes, one review pass, land, and hygiene always last (ENGINEERING-STANDARD (i)).',
  whenToUse:
    "A round of work with a task and one to three lanes, each a repository clone; pass args { runDir, task, lanes: [{ repo, clone, mechanical }], backend?, gateLock? }. Without backend (a flow developer with only snoopy-automations) hygiene reports the kit's quick-hygiene facts.",
  phases: [
    { title: 'Design', detail: 'the plan and one brief per lane' },
    { title: 'Lanes', detail: 'at most three builders; one heavy gate at a time' },
    { title: 'Review', detail: 'one reviewer pass per lane' },
    { title: 'Land', detail: 'push, the PR, the required check' },
    {
      title: 'Hygiene',
      detail: 'hygiene --clean, then --strict (the run only, without a backend); always last',
    },
  ],
};

// ENGINEERING-STANDARD (i). At most MAX_AGENTS agents at once, one heavy gate at a time (the
// gate lock). Lanes get their briefs by path; every stage writes 2 KB or less to
// <runDir>/<stage>.summary.md and returns only that path. No message is ever sent to a
// running agent. The hygiene stage runs last whatever happened before it (A4). The summaries
// stay in <runDir>, read by path; the session gets the top-level return value (below).
//
// Failures (BUILD-PLAN 29.3.3). API retries are the harness's: agent() is null only after "a
// terminal API error after retries" (the workflow-authoring reference), so this script adds
// none — our rule: do not stack retries on a layer that already retries (Anthropic's SDK
// retries transient failures "twice by default", platform.claude.com/docs/en/api/errors). An
// agent that throws or comes back null or empty is run once more with the failure named, then
// recorded as a named gap, never filled by a guess ("letting the agent know when a tool is
// failing and letting it adapt works surprisingly well", anthropic.com/engineering/
// multi-agent-research-system; "Set limits on agent retries", OpenAI's practical guide to
// building agents). agent() can fail after its agent has already acted, so a step that is not
// safe to repeat is never retried blindly: its retry first reads the step's own effect and
// resumes from it. The lane (its commits) resumes from `git log origin/main..HEAD` and `git
// status`; land (push, PR, ready) from `git status -sb` and `gh pr list --head`, one PR per
// branch. Design (it rewrites its own files), review (its verdict file) and hygiene (it cleans
// again) are safe to repeat and retry plainly. A reviewer that could not make a check says UNKNOWN ("give the LLM a way
// out", anthropic.com/engineering/demystifying-evals-for-ai-agents); UNKNOWN never lands, and
// nor does a FAIL after the one return to the lane: both are gaps. Every gap is log()ged, as
// `gap: …` lines, before the closing `build-round:` line, and returned with it; the session shows
// them to the owner as a stop. A throw outside an agent call is a gap too, never thrown again:
// the return still carries every finished lane, every gap and the error, so nothing is lost. Each
// lane's verdict and land result are recorded by lane index the moment its stage finishes, not
// through pipeline()'s resolved array (a rejected batch drops that whole); a lane with no record is
// a gap worded "not known: no stage reported", with what to read before any rerun, never a guess.
//
// No backend checkout (Round 21, a flow developer with only snoopy-automations): `backend` and
// `gateLock` are optional. Without `backend` the hygiene stage reports the kit's quick-hygiene
// facts from the first lane's clone and removes only what this run started; the machine-wide
// `hygiene --strict` stays the owner's, at round close. Without `gateLock` the lanes use the
// installed gate lock when ~/.claude/autom8x/gate-lock.mjs exists and, when it does not, run one
// heavy step at a time in the lane (a flow is one lane, and lane, review and land run in order).
const MAX_AGENTS = 3;
const input = args ?? {};
const { runDir, backend, task } = input;
const lanes = Array.isArray(input.lanes) ? input.lanes : [];
if (!runDir || !task || lanes.length === 0) {
  throw new Error('build-round needs args { runDir, task, lanes: [{ repo, clone }], backend? }');
}
const INSTALLED_LOCK = '~/.claude/autom8x/gate-lock.mjs';
const summary = (stage) =>
  `Write 2 KB or less to ${runDir}/${stage}.summary.md and return only that path.`;
const between = (gate) =>
  `run only between \`${gate} acquire <label>\` and \`${gate} release <label>\`; always release`;
const heavy = input.gateLock
  ? `Heavy steps (npm ci, verify, a whole test run, Docker, local-ci) ${between(input.gateLock)}.`
  : `Heavy steps (npm ci, verify, a whole test run, Docker, local-ci): if ${INSTALLED_LOCK} ` +
    `exists, they ${between(`node ${INSTALLED_LOCK}`)}; if it does not, run one heavy step at ` +
    `a time in this lane.`;
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN'] },
    path: { type: 'string' },
    fixes: { type: 'number' },
  },
  required: ['verdict', 'path', 'fixes'],
};

const gaps = [];
const message = (error) => String(error?.message ?? error).slice(0, 200);
/** One call; a throw is a failure, never the end of the run. */
async function attempt(run, extra) {
  try {
    return { out: await run(extra) };
  } catch (error) {
    return { out: null, why: `it threw (${message(error)})` };
  }
}
/** A retry's first words: the failure named and, for a step not safe to repeat, what to read first. */
const retryText = (why, resume) =>
  resume
    ? `An earlier attempt at this step failed (${why}) and may already have done part of it. ` +
      `Before anything else, ${resume}; continue from what it did and never redo it. `
    : `An earlier attempt at this step failed (${why}). `;
/**
 * One run, then one more with the failure named; a second failure is a named gap. `resume`, for a
 * step not safe to repeat, says how the retry reads what the first attempt already did.
 */
async function once(label, run, resume) {
  const first = await attempt(run, '');
  if (first.out) return first.out;
  const why = first.why ?? (first.out === null ? 'it ended with an error' : 'it returned nothing');
  log(`${label}: ${why}; one retry${resume ? ', resuming from what the first attempt did' : ''}`);
  const second = await attempt(run, retryText(why, resume));
  if (second.out) return second.out;
  const why2 =
    second.why ?? (second.out === null ? 'it ended with an error' : 'it returned nothing');
  gaps.push(`${label}: failed twice (${why}; then ${why2})`);
  return null;
}

/**
 * Each item through `stages`, at most MAX_AGENTS items at a time, one agent per item. The stages
 * write their own results into `record` (below) as each finishes, so a batch that rejects, even
 * after its stages ran, loses nothing that finished.
 */
async function inBatches(items, ...stages) {
  for (let i = 0; i < items.length; i += MAX_AGENTS) {
    await pipeline(items.slice(i, i + MAX_AGENTS), ...stages);
  }
}

const brief = (lane) => `${runDir}/brief-${lane.repo}.md`;
const build = (lane, extra = '') =>
  once(
    `lane ${lane.repo}`,
    (retry) =>
      agent(
        `${retry}You are the lane for ${lane.repo} in ${lane.clone}. Read only ${brief(lane)}, docs/MAP.md ` +
          `and the files it names. ${heavy} Run only what your change touches — its tests, ` +
          `format and types — never the full gate (verify, browser suites, local-ci): it runs once ` +
          `per pull request, at the land step (the owner's 2026-10-26 speed-up 1). ` +
          `Commit with the docs in the same commit; do not push. ` +
          `${extra}List every process, container, worktree and temp folder you started and stop ` +
          `or remove each. ${summary(`lane-${lane.repo}`)}`,
        {
          label: `lane ${lane.repo}`,
          phase: 'Lanes',
          agentType: 'builder',
          model: lane.mechanical ? 'sonnet' : 'opus',
          effort: 'medium',
        },
      ),
    `read \`git -C ${lane.clone} log --oneline origin/main..HEAD\` and \`git -C ${lane.clone} ` +
      `status --short\` (what it committed and what it left uncommitted); never commit a change twice`,
  );
const review = (lane) =>
  once(`review ${lane.repo}`, (retry) =>
    agent(
      `${retry}Review ${lane.clone} in one pass: \`git diff origin/main..HEAD\` against ${brief(lane)}. ` +
        `Run \`npm run check:docs\`; check the lane's leftovers in ` +
        `${runDir}/lane-${lane.repo}.summary.md against ps, docker ps and git worktree list. ` +
        `Write PASS, FAIL, or UNKNOWN — <why> for a check you could not make (never PASS for ` +
        `a check not made), with 10 findings or fewer (file:line) to ` +
        `${runDir}/review-${lane.repo}.verdict.md. Return the verdict, that path, and how many ` +
        `fixes it needs.`,
      {
        label: `review ${lane.repo}`,
        phase: 'Review',
        agentType: 'reviewer',
        model: 'opus',
        effort: 'high',
        schema: VERDICT,
      },
    ),
  );

let designed = null;
/** By lane index: { verdict } once the review stage finishes, plus `landed` once land does. */
const record = [];
let hygiene = null;
let thrown = null;
try {
  phase('Design');
  designed = await once('design', (retry) =>
    agent(
      `${retry}Design this round: ${task}. Lanes: ${lanes.map((l) => `${l.repo} at ${l.clone}`).join('; ')}. ` +
        `Write the plan to ${runDir}/plan.md and one brief per lane to ${runDir}/brief-<repo>.md ` +
        `(the files it may open, the tests that must bite, the gate), then ${runDir}/design.done. ` +
        `${summary('design')}`,
      { label: 'design', phase: 'Design', agentType: 'builder', model: 'opus', effort: 'high' },
    ),
  );
  if (designed) {
    await inBatches(
      lanes,
      async (lane) => ({ lane, built: await build(lane) }),
      async ({ lane, built }) => {
        if (!built) {
          record[lanes.indexOf(lane)] = { verdict: null };
          return { lane, verdict: null };
        }
        let verdict = await review(lane);
        // Six fixes or fewer are made by hand; more go back to the lane once.
        if (verdict?.verdict === 'FAIL') {
          const extra = `Apply every finding in ${verdict.path}${verdict.fixes > 6 ? ' (one return to the lane)' : ', by hand, nothing else'}. `;
          if (await build(lane, extra)) verdict = await review(lane);
        }
        if (verdict?.verdict === 'UNKNOWN')
          gaps.push(
            `review ${lane.repo}: UNKNOWN, a check could not be made (${verdict.path}); not landed`,
          );
        if (verdict?.verdict === 'FAIL')
          gaps.push(`review ${lane.repo}: FAIL after the one return (${verdict.path}); not landed`);
        record[lanes.indexOf(lane)] = { verdict };
        return { lane, verdict };
      },
      async ({ lane, verdict }) => {
        if (verdict?.verdict !== 'PASS') return { lane, landed: null, verdict };
        const result = await once(
          `land ${lane.repo}`,
          (retry) =>
            agent(
              `${retry}Land ${lane.clone}: the repository's full local gate once, on the committed tree ` +
                `(snoopy-backend: none here — the Mac runner's local CI runs it on the push), then ` +
                `a normal push (never --no-verify), one PR whose body ends with ` +
                `"🤖 Generated with [Claude Code](https://claude.com/claude-code)", then the required ` +
                `check. Mark it ready only when it is green on the head. ${summary(`land-${lane.repo}`)}`,
              {
                label: `land ${lane.repo}`,
                phase: 'Land',
                agentType: 'builder',
                model: 'sonnet',
                effort: 'low',
              },
            ),
          `in ${lane.clone}, read \`git status -sb\` (whether the branch is pushed) and ` +
            `\`gh pr list --head "$(git branch --show-current)" --state all\` (its PR, draft or ` +
            `ready); one PR per branch, never a second`,
        );
        record[lanes.indexOf(lane)].landed = result;
        return { lane, landed: result, verdict };
      },
    );
  }
} catch (error) {
  // A throw outside an agent call: a gap, and the error in the return; never thrown again, so the
  // finished lanes and the gaps still reach the session.
  thrown = error;
  gaps.push(`run: a step threw (${message(error)})`);
} finally {
  phase('Hygiene');
  const sweep = backend
    ? `In ${backend}, run \`npm run hygiene -- --clean --session ${runDir}\`, then ` +
      `\`npm run hygiene -- --strict\`, and report both last lines verbatim with every owner: ` +
      `line. Never run --execute.`
    : `There is no backend checkout. In ${lanes[0].clone}, run \`node --input-type=module -e ` +
      `"const m = await import('./.claude/hooks/lib/quick-hygiene.mjs'); ` +
      `console.log(m.quickSummary().join('\\n'))"\` and report its hygiene: line verbatim. Stop or ` +
      `remove only what this run started (each leftover the lanes list in ` +
      `${runDir}/lane-*.summary.md), never the run's summaries and never anything else; the ` +
      `machine-wide hygiene --strict is the owner's, at round close.`;
  hygiene = await once('hygiene', (retry) =>
    agent(`${retry}${sweep} ${summary('hygiene')}`, {
      label: 'hygiene',
      phase: 'Hygiene',
      agentType: 'builder',
      model: 'haiku',
      effort: 'low',
    }),
  );
}

// The session reads the top-level return value, not these log lines (ENGINEERING-STANDARD (i));
// they stay for the run's own record. A top-level return is why test/workflows.test.ts compiles
// this file as the harness runs it, an async function body, not with `node --check`. Every lane
// gets a line and an entry from `record`, so none is dropped silently; a lane whose stage never
// reported is not known, so its gap says what to read, not what happened.
log(`design ${designed ?? 'did not finish'}; hygiene ${hygiene ?? 'did not finish'}`);
lanes.forEach((lane, i) => {
  const item = record[i];
  const read =
    `read \`git -C ${lane.clone} status -sb\` and \`gh pr list --head ` +
    `"$(git -C ${lane.clone} branch --show-current)" --state all\` before any rerun`;
  if (designed && !item) gaps.push(`${lane.repo}: not known: no stage reported; ${read}`);
  else if (item?.verdict?.verdict === 'PASS' && item.landed === undefined)
    gaps.push(`${lane.repo}: land not known: no stage reported after its PASS; ${read}`);
  log(`${lane.repo}: ${item?.verdict?.verdict ?? 'no verdict'}, landed ${item?.landed ?? 'no'}`);
});
for (const g of gaps) log(`gap: ${g}`);
const closing = `build-round: ${gaps.length ? `stopped with ${gaps.length} gap(s), each logged above` : 'done, no gaps'}`;
log(closing);
return {
  stopped: gaps.length > 0,
  closing,
  gaps,
  error: thrown ? message(thrown) : null,
  design: designed,
  lanes: lanes.map((lane, i) => ({
    repo: lane.repo,
    verdict: record[i]?.verdict?.verdict ?? null,
    verdictPath: record[i]?.verdict?.path ?? null,
    landed: record[i]?.landed ?? null,
  })),
  hygiene,
};
