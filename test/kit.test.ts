import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The shared kit (the engineering standard's section 0: `.claude/hooks/`,
 * `.claude/agents/`, `scripts/kit/`), byte-identical in all four repositories. Its
 * own tests run here, inside this repository's gate; then the kit is run against
 * this repository: `docs/MAP.md` is current, `docs/docs-map.json` is sound and the
 * line limits hold, and `.claude/settings.json` runs the three hooks.
 */
await import(new URL('../scripts/kit/kit.test.mjs', import.meta.url).href);

const repositoryRoot = resolve(import.meta.dirname, '..');
const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(repositoryRoot, script), ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });

test('docs/MAP.md is current (npm run map -- --check)', () => {
  const result = run('scripts/kit/map.mjs', '--check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('docs/docs-map.json is sound and the line limits hold (check-docs --map-only)', () => {
  const result = run('scripts/kit/check-docs.mjs', '--map-only');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout: number }[];
}

test('.claude/settings.json runs the three kit hooks', () => {
  const settings = JSON.parse(
    readFileSync(join(repositoryRoot, '.claude/settings.json'), 'utf8'),
  ) as { hooks: Record<string, HookGroup[]> };
  const entries = (event: string) =>
    (settings.hooks[event] ?? []).flatMap((group) =>
      group.hooks.map((hook) => ({ matcher: group.matcher, ...hook })),
    );
  const hook = (file: string, timeout: number, matcher?: string) => ({
    matcher,
    type: 'command',
    command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`,
    timeout,
  });
  assert.deepEqual(entries('PreToolUse'), [
    hook('guard.mjs', 5, 'Bash|Write|Edit|NotebookEdit|Artifact'),
  ]);
  assert.deepEqual(entries('SessionStart'), [hook('session-start.mjs', 10)]);
  assert.deepEqual(entries('Stop'), [hook('stop-check.mjs', 10)]);
  assert.deepEqual(entries('SubagentStop'), [hook('stop-check.mjs', 10)]);
});

/**
 * `/create-flow` stage 4 runs the kit's `build-round` (carried byte for byte) with the arguments
 * its SKILL.md names, and they are the ones the carried script takes: `session`, which replaced
 * `runDir` (BUILD-PLAN 30.17.2; briefs, summaries and verdicts travel inline). The script runs as
 * the Workflow tool runs it, an async function body, with stand-in agents; the design finds the
 * task is not a build, so no lane runs and the hygiene stage reads that session. No file of the
 * skill, nor the research workflows, names a run folder.
 */
test('/create-flow calls build-round with { session, task, lanes }, the arguments it takes', async () => {
  const skillRoot = join(repositoryRoot, '.claude/skills/create-flow');
  const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');
  const call = /`build-round` workflow[\s\S]*?with `(\{[^`]*\})`/u.exec(skill)?.[1] ?? '';
  const keys = [...call.replace(/\[[^\]]*\]/gu, '').matchAll(/(\w+)\s*(?=[,:}])/gu)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(keys, ['session', 'task', 'lanes'], `SKILL.md's call: ${call}`);
  const session = '/scratch/project/session';
  const given: Record<string, unknown> = {
    session,
    task: 'a flow',
    lanes: [{ repo: 'snoopy-automations', clone: '/scratch/clones/snoopy-automations' }],
    runDir: '/scratch/run',
  };
  const prompts: string[] = [];
  const agent = async (prompt: string, opts: { label: string }) => {
    prompts.push(prompt);
    return opts.label === 'design' ? { build: false, plan: 'not a build', briefs: [] } : 'clean';
  };
  const source = readFileSync(join(repositoryRoot, '.claude/workflows/build-round.js'), 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = new AsyncFunction(
    'args',
    'agent',
    'pipeline',
    'phase',
    'log',
    source.replace('export const meta', 'const meta'),
  );
  const runWith = (args: unknown) =>
    body(
      args,
      agent,
      async () => [],
      () => {},
      () => {},
    );
  const result = await runWith(Object.fromEntries(keys.map((key) => [key, given[key]])));
  assert.deepEqual(result.gaps, [
    'design: NOT-A-BUILD (not a build); the task is not a build, so no lane ran',
  ]);
  assert.ok(prompts.at(-1)!.includes(`looseFiles('${session}')`), 'hygiene reads the session');
  await assert.rejects(runWith({ ...given, session: undefined }), /replaced runDir/u);
  const files = [
    ...readdirSync(skillRoot, { recursive: true, encoding: 'utf8' }).map((f) => join(skillRoot, f)),
    ...['flow-research.js', 'flow-research-tables.js', 'flow-research-integrations.js'].map((f) =>
      join(repositoryRoot, '.claude/workflows', f),
    ),
  ].filter((f) => statSync(f).isFile());
  for (const file of files)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /<runDir>|\$\{runDir\}|\{ runDir\b/u, file);
});

/**
 * This repository's flow rules (Round 21, R1): a flow's `src`, `prompts` and manifests each ask
 * for that flow's own README — the `*` of `automations/*\/README.md` bound to the flow's id — and
 * never another flow's. Run by the kit's `checkRange` on commits in a scratch repository that
 * carries this repository's `docs/docs-map.json`.
 */
test('a flow’s code, prompts or manifest change asks for its own README, and no other flow’s', async () => {
  const { checkRange } = (await import(
    new URL('../scripts/kit/check-docs.mjs', import.meta.url).href
  )) as {
    checkRange: (
      root: string,
      map: unknown,
      commits: string[],
    ) => { problems: { message: string }[] };
  };
  const map = JSON.parse(
    readFileSync(join(repositoryRoot, 'docs/docs-map.json'), 'utf8'),
  ) as unknown;
  const scratch = mkdtempSync(join(tmpdir(), 'kit-flow-rules-'));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        {
          cwd: scratch,
          encoding: 'utf8',
        },
      ).trim();
    git('init', '-q');
    const commit = (files: string[]) => {
      for (const file of files) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        writeFileSync(join(scratch, file), `${file} ${Math.random()}\n`);
      }
      git('add', '-A');
      git('commit', '-q', '-m', 'a change');
      return git('rev-parse', 'HEAD');
    };
    commit([
      'automations/invoice-processing/README.md',
      'automations/candidate-reviewer/README.md',
    ]);
    const problems = (files: string[]) =>
      checkRange(scratch, map, [commit(files)]).problems.map((p) => p.message);
    assert.deepEqual(
      problems(['manifests/invoice-processing.v8.json']),
      [
        'rule manifests: manifests/invoice-processing.v8.json changed without automations/invoice-processing/README.md',
      ],
      'a manifest-only change without its flow’s README fails',
    );
    assert.deepEqual(
      problems([
        'manifests/invoice-processing.v9.json',
        'automations/invoice-processing/README.md',
      ]),
      [],
    );
    assert.deepEqual(
      problems([
        'automations/invoice-processing/src/a.ts',
        'automations/candidate-reviewer/README.md',
      ]),
      [
        'rule automations: automations/invoice-processing/src/a.ts changed without automations/invoice-processing/README.md',
      ],
      'another flow’s README does not meet it',
    );
    assert.deepEqual(problems(['automations/candidate-reviewer/prompts/p.json']), [
      'rule automations: automations/candidate-reviewer/prompts/p.json changed without automations/candidate-reviewer/README.md',
    ]);
    assert.deepEqual(
      problems([
        'automations/candidate-reviewer/prompts/q.json',
        'automations/candidate-reviewer/README.md',
      ]),
      [],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
