export const meta = {
  name: 'build-round',
  description:
    'Build one round across up to three repository clones: design, lanes, one review pass, land, and hygiene always last (ENGINEERING-STANDARD (i)).',
  whenToUse:
    "A round of work with a task and one to three lanes, each a repository clone; pass args { session, task, lanes: [{ repo, clone, mechanical }], backend?, gateLock? }, session the session's scratch folder. Briefs, summaries and verdicts travel inline; nothing is written outside the clones. Without backend (a flow developer with only snoopy-automations) hygiene reports the kit's quick-hygiene facts.",
  phases: [
    { title: 'Design', detail: 'the plan and one brief per lane, returned' },
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
// gate lock). Files only inside repository copies (the owner, 2026-11-14; BUILD-PLAN 30.17): the
// design returns the plan and one brief per lane through a schema, each lane gets its brief in its
// prompt, every stage returns its summary or verdict (2 KB or less) in its reply, and review, fix
// and hygiene get what they need inline; nothing goes to a run folder. No message is ever sent to a
// running agent. The hygiene stage runs last whatever happened before it (A4). The session gets
// the top-level return value (below).
//
// Failures (BUILD-PLAN 29.3.3; the rule and its sources: ENGINEERING-STANDARD (i), "Failures, in
// both"): no API retry of our own; an agent that throws or comes back null or empty runs once
// more with the failure named, then is a named gap, never filled by a guess. A step not safe to
// repeat resumes from its own effect: the lane (its commits) from `git log origin/main..HEAD` and
// `git status`; land (push, PR, ready) from `git status -sb` and `gh pr list --head`, one PR per
// branch. Design and review (they write nothing) and hygiene (it cleans again) retry plainly. A
// reviewer's UNKNOWN, and a FAIL after the one return to the lane, never land: both are gaps. Every
// gap is a `gap: …` log line before the closing `build-round:` line, and is returned; a throw
// outside an agent call is a gap too, never thrown again. Each lane's verdict and land result are
// recorded by lane index as its stage finishes, not through pipeline()'s resolved array (a rejected
// batch drops that whole); a lane with no record is "not known: no stage reported", with what to
// read before any rerun.
//
// Round 21 (j), change-aware since the change-aware gates (ENGINEERING-STANDARD's gate rule):
// land runs the repository's change-aware local gate (LAND_GATES) under the gate lock before any
// push and records its counts — the platform's classifier picks ci.yml's light steps for a
// records change and `CI=true npm run verify` for anything else; a design that finds the task is not a build returns
// `build: false` with its reason, so no lane runs, the gap (`design: NOT-A-BUILD …`) is recorded and
// hygiene still runs. A lane the design wrote no brief for does not run either: a gap.
//
// No backend checkout (Round 21, a flow developer with only snoopy-automations): `backend` and
// `gateLock` are optional. Without `backend` the hygiene stage reports the kit's quick-hygiene
// facts, the session's loose files among them, from the first lane's clone and removes only what
// this run started, the leftovers the lanes reported (given inline); the machine-wide
// `hygiene --strict` stays the owner's, at round close. Without `gateLock` the lanes use the
// installed gate lock when ~/.claude/autom8x/gate-lock.mjs exists and, when it does not, run one
// heavy step at a time in the lane (a flow is one lane, and lane, review and land run in order).
const MAX_AGENTS = 3;
const input = args ?? {};
const { session, backend, task } = input;
const lanes = Array.isArray(input.lanes) ? input.lanes : [];
if (!session || !task || lanes.length === 0) {
  throw new Error(
    'build-round needs args { session, task, lanes: [{ repo, clone }], backend? }: session, the ' +
      "session's scratch folder (hygiene's --session), replaced runDir; briefs, summaries and " +
      'verdicts travel inline (BUILD-PLAN 30.17)',
  );
}
const INSTALLED_LOCK = '~/.claude/autom8x/gate-lock.mjs';
/** Every stage's result, in its reply; nothing is written outside a repository copy (guard #10). */
const summary =
  'Return in your reply a summary of 2 KB or less: what you did, the gates with their counts, ' +
  'and the leftovers list (what you started and stopped, and anything left). Write no summary, ' +
  'note or log file anywhere: files only inside a repository copy (the owner, 2026-11-14).';
/** A short one-line form of an agent's text, for a gap or a log line. */
const clip = (text) => `${text ?? ''}`.replace(/\s+/gu, ' ').slice(0, 200);
const between = (gate) =>
  `run only between \`${gate} acquire <label>\` and \`${gate} release <label>\`; always release`;
// The backend's local-ci takes the machine's gate lock itself, so it is never listed among the
// steps to wrap: a session that wrapped it waited 90 minutes for the lock to go stale
// (2026-11-06, snoopy-backend SYSTEM-MANIFEST §12.1 #353).
const LOCAL_CI =
  " The backend's `node scripts/local-ci.mjs` takes the gate lock itself: run it without " +
  'acquiring, never inside an acquire.';
const heavy =
  (input.gateLock
    ? `Heavy steps (npm ci, verify, a whole test run, Docker) ${between(input.gateLock)}.`
    : `Heavy steps (npm ci, verify, a whole test run, Docker): if ${INSTALLED_LOCK} ` +
      `exists, they ${between(`node ${INSTALLED_LOCK}`)}; if it does not, run one heavy step at ` +
      `a time in this lane.`) + LOCAL_CI;
/**
 * Each repository's change-aware local gate, run at land under the gate lock BEFORE any push, its
 * counts recorded (Round 21, j: the backend's pushed on a gate a lane had not run). The backend
 * keeps `CI=true npm run verify` for anything but records, because a PR's suite runs only in
 * local CI, after the push (snoopy-backend SYSTEM-MANIFEST §12.1 #357). Unknown repos: verify.
 */
const LAND_GATES = {
  'snoopy-backend':
    "`node scripts/ci-classify.mjs --plan --run` (records: ci.yml's light steps; anything " +
    'else `CI=true npm run verify`)',
  snoopy:
    'the change audit (.claude/agents/change-auditor.md) and ' +
    '`node scripts/audit/record-pass.mjs`, then the push, whose pre-push hook runs ' +
    '`node scripts/change-class.mjs` (the change-aware gate)',
  'snoopy-mobile': '`node scripts/change-class.mjs --run` (its pre-push hook runs the same set)',
  'snoopy-automations': '`npm run verify`',
};
const landGate = (repo) => LAND_GATES[repo] ?? '`npm run verify`';
/** A design's answer: whether the task is a build, the plan (or why not), one brief per lane. */
const DESIGN = {
  type: 'object',
  properties: {
    build: { type: 'boolean' },
    plan: { type: 'string' },
    briefs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { repo: { type: 'string' }, brief: { type: 'string' } },
        required: ['repo', 'brief'],
      },
    },
  },
  required: ['build', 'plan', 'briefs'],
};
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'UNKNOWN'] },
    findings: { type: 'string' },
    fixes: { type: 'number' },
  },
  required: ['verdict', 'findings', 'fixes'],
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

/** The brief the design returned for a lane, or null. */
const briefOf = (lane) =>
  designed?.briefs?.find(
    (b) => b?.repo === lane.repo && typeof b.brief === 'string' && b.brief.trim() !== '',
  )?.brief ?? null;
const build = (lane, extra = '') =>
  once(
    `lane ${lane.repo}`,
    (retry) =>
      agent(
        `${retry}You are the lane for ${lane.repo} in ${lane.clone}. Your brief:\n${briefOf(lane)}\n` +
          `Read only docs/MAP.md and the files the brief names. ${heavy} Run only what your change ` +
          `touches — its tests, format and types — never the full gate (verify, browser suites, ` +
          `local-ci): it runs once per pull request, at the land step (the owner's 2026-10-26 ` +
          `speed-up 1). Commit with the docs in the same commit; do not push. ` +
          `${extra}List every process, container, worktree and temp folder you started and stop ` +
          `or remove each. ${summary}`,
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
      `${retry}Review ${lane.clone} in one pass: \`git diff origin/main..HEAD\` against its brief:\n` +
        `${briefOf(lane)}\nRun \`npm run check:docs\`; check the leftovers in the lane's report ` +
        `against ps, docker ps and git worktree list. The lane's report:\n` +
        `${reports[lanes.indexOf(lane)] ?? '(none)'}\nReturn PASS, FAIL, or UNKNOWN — <why> for a ` +
        `check you could not make (never PASS for a check not made), with 10 findings or fewer ` +
        `(file:line — problem — fix) as the findings, and how many fixes it needs. Write no file.`,
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
let notABuild = false;
/** By lane index: the lane's own report (its summary and leftovers), as it returned it. */
const reports = [];
/** By lane index: { verdict } once the review stage finishes, plus `landed` once land does. */
const record = [];
let hygiene = null;
let thrown = null;
try {
  phase('Design');
  designed = await once('design', (retry) =>
    agent(
      `${retry}Design this round: ${task}. Lanes: ${lanes.map((l) => `${l.repo} at ${l.clone}`).join('; ')}. ` +
        `First decide whether the task is a build (a change to make). If it is not — a question, ` +
        `a list, a status read — return build false, the reason (2 KB or less) as the plan, and ` +
        `no briefs. Otherwise return build true, the plan (2 KB or less), and one brief per lane ` +
        `with its repo (the files it may open, the tests that must bite, the gate). Write no file: ` +
        `the plan and the briefs travel in your answer (the owner, 2026-11-14).`,
      {
        label: 'design',
        phase: 'Design',
        agentType: 'builder',
        model: 'opus',
        effort: 'high',
        schema: DESIGN,
      },
    ),
  );
  // A task that is not a build runs no lane; the gap says so and hygiene still runs (Round 21, j).
  notABuild = designed?.build === false;
  if (notABuild) {
    gaps.push(
      `design: NOT-A-BUILD (${clip(designed.plan)}); the task is not a build, so no lane ran`,
    );
  } else if (designed) {
    // A lane with no brief is not guessed at: it does not run, and is a gap.
    const briefed = lanes.filter((lane) => briefOf(lane) !== null);
    for (const lane of lanes.filter((l) => !briefed.includes(l))) {
      record[lanes.indexOf(lane)] = { verdict: null };
      gaps.push(`design: no brief for ${lane.repo}; that lane did not run`);
    }
    await inBatches(
      briefed,
      async (lane) => {
        const built = await build(lane);
        reports[lanes.indexOf(lane)] = built;
        return { lane, built };
      },
      async ({ lane, built }) => {
        if (!built) {
          record[lanes.indexOf(lane)] = { verdict: null };
          return { lane, verdict: null };
        }
        let verdict = await review(lane);
        // Six fixes or fewer are made by hand; more go back to the lane once.
        if (verdict?.verdict === 'FAIL') {
          const extra =
            `Apply every finding of the review${verdict.fixes > 6 ? ' (one return to the lane)' : ', by hand, nothing else'}:\n` +
            `${verdict.findings}\n`;
          const fixed = await build(lane, extra);
          if (fixed) {
            reports[lanes.indexOf(lane)] = fixed;
            verdict = await review(lane);
          }
        }
        if (verdict?.verdict === 'UNKNOWN')
          gaps.push(
            `review ${lane.repo}: UNKNOWN, a check could not be made (${clip(verdict.findings)}); not landed`,
          );
        if (verdict?.verdict === 'FAIL')
          gaps.push(
            `review ${lane.repo}: FAIL after the one return (${clip(verdict.findings)}); not landed`,
          );
        record[lanes.indexOf(lane)] = { verdict };
        return { lane, verdict };
      },
      async ({ lane, verdict }) => {
        if (verdict?.verdict !== 'PASS') return { lane, landed: null, verdict };
        const result = await once(
          `land ${lane.repo}`,
          (retry) =>
            agent(
              `${retry}Land ${lane.clone}: BEFORE any push, the repository's change-aware local ` +
                `gate once, ` +
                `on the committed tree: ${landGate(lane.repo)}. ${heavy} Put the HEAD sha and ` +
                `the gate's pass, fail and skipped counts in the summary, and push only when it is ` +
                `green for that same HEAD (a moved HEAD runs it again). Then ` +
                `a normal push (never --no-verify), one PR whose body ends with ` +
                `"🤖 Generated with [Claude Code](https://claude.com/claude-code)", then the required ` +
                `check. Mark it ready only when it is green on the head. ${summary}`,
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
  const leftovers = lanes
    .map((lane, i) => `${lane.repo}: ${reports[i] ?? '(the lane reported nothing)'}`)
    .join('\n');
  const sweep = backend
    ? `In ${backend}, run \`npm run hygiene -- --clean --session ${session}\`, then ` +
      `\`npm run hygiene -- --strict\`, and report both last lines verbatim with every owner: ` +
      `line. Never run --execute.`
    : `There is no backend checkout. In ${lanes[0].clone}, run \`node --input-type=module -e ` +
      `"const m = await import('./.claude/hooks/lib/quick-hygiene.mjs'); ` +
      `const l = m.looseFiles('${session}'); ` +
      `console.log([...m.quickSummary(), 'loose files ' + m.counted(l), ...l.paths].join('\\n'))"\` ` +
      `and report its hygiene: and loose files lines verbatim. Stop or remove only what this run ` +
      `started — each leftover the lanes reported, below — and never anything else; the ` +
      `machine-wide hygiene --strict is the owner's, at round close. The lanes' reports:\n${leftovers}\n`;
  hygiene = await once('hygiene', (retry) =>
    agent(`${retry}${sweep} ${summary}`, {
      label: 'hygiene',
      phase: 'Hygiene',
      agentType: 'builder',
      model: 'haiku',
      effort: 'low',
    }),
  );
}

// The session reads the top-level return value, not these log lines (ENGINEERING-STANDARD (i)),
// which is why test/workflows.test.ts compiles this file as an async function body. Every lane
// gets a line and an entry; one whose stage never reported is not known: its gap says what to read.
log(
  `design ${designed ? clip(designed.plan) : 'did not finish'}; hygiene ${hygiene ? clip(hygiene) : 'did not finish'}`,
);
lanes.forEach((lane, i) => {
  const item = record[i];
  const read =
    `read \`git -C ${lane.clone} status -sb\` and \`gh pr list --head ` +
    `"$(git -C ${lane.clone} branch --show-current)" --state all\` before any rerun`;
  if (designed && !notABuild && !item)
    gaps.push(`${lane.repo}: not known: no stage reported; ${read}`);
  else if (item?.verdict?.verdict === 'PASS' && item.landed === undefined)
    gaps.push(`${lane.repo}: land not known: no stage reported after its PASS; ${read}`);
  log(
    `${lane.repo}: ${item?.verdict?.verdict ?? 'no verdict'}, landed ${item?.landed ? clip(item.landed) : 'no'}`,
  );
});
for (const g of gaps) log(`gap: ${g}`);
const closing = `build-round: ${gaps.length ? `stopped with ${gaps.length} gap(s), each logged above` : 'done, no gaps'}`;
log(closing);
return {
  stopped: gaps.length > 0,
  closing,
  gaps,
  error: thrown ? message(thrown) : null,
  design: designed?.plan ?? null,
  lanes: lanes.map((lane, i) => ({
    repo: lane.repo,
    report: reports[i] ?? null,
    verdict: record[i]?.verdict?.verdict ?? null,
    findings: record[i]?.verdict?.findings ?? null,
    landed: record[i]?.landed ?? null,
  })),
  hygiene,
};
