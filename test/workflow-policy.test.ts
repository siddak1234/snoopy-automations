import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * What this public repository's workflows may do (the platform's ADR-0047 §1 and §7(b)):
 * no trigger that runs a fork's code with this repository's rights; one secret,
 * DISPATCH_APP_KEY, read by Deploy alone; Deploy only on a push to main, in `production`,
 * with no GITHUB_TOKEN permission and no code of this repository; Publish attesting each
 * digest after both scans and before the tag, and holding the attestation permissions
 * alone; every matrix List's, never typed by hand; every action pinned by SHA;
 * all-green seeing every job; every job but a call held to a time limit; and the nightly, its own
 * workflow calling ci.yml whole, a red night reported by a job that can write issues alone (Round
 * 21 hardening, NIGHT-8). The text is read block by block, with no YAML library.
 */

const workflowsRoot = resolve(import.meta.dirname, '..', '.github', 'workflows');
const workflowFiles = readdirSync(workflowsRoot).filter((name) => /\.ya?ml$/u.test(name));
const read = (name: string) => readFileSync(join(workflowsRoot, name), 'utf8');

/** The lines that are not comments: a rule is held by what runs, not what is said. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');

/** Each job's block, by its id: from `  <id>:` under `jobs:` to the next job. */
function jobs(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  assert.ok(start >= 0, 'the workflow has a jobs: block');
  const blocks = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header) {
      current = [];
      blocks.set(header[1]!, current);
    } else if (/^\S/u.test(line)) {
      current = undefined;
    } else {
      current?.push(line);
    }
  }
  return new Map([...blocks].map(([id, block]) => [id, code(block.join('\n'))]));
}

/** A job's steps, in order: each `      - ` item under its `steps:`. */
function steps(job: string): string[] {
  const body = job.split(/^ {4}steps:\s*$/mu)[1];
  assert.ok(body !== undefined, 'the job has steps');
  return body.split(/^ {6}- /mu).slice(1);
}

const ci = read('ci.yml');
const ciJobs = jobs(ci);
const job = (id: string) => {
  const block = ciJobs.get(id);
  assert.ok(block !== undefined, `ci.yml has a ${id} job`);
  return block;
};

test('no workflow runs on pull_request_target or workflow_run', () => {
  assert.ok(workflowFiles.length > 0);
  for (const file of workflowFiles) {
    assert.doesNotMatch(code(read(file)), /\b(pull_request_target|workflow_run)\b/u, file);
  }
});

test('the only secret is DISPATCH_APP_KEY, and only Deploy reads it', () => {
  const reads: string[] = [];
  for (const file of workflowFiles) {
    const text = read(file);
    const header = code(text.split(/^jobs:\s*$/mu)[0]!);
    assert.doesNotMatch(header, /\bsecrets\b/u, `${file} reads a secret outside its jobs`);
    for (const [id, block] of jobs(text)) {
      for (const match of block.matchAll(/\bsecrets\b(\.[A-Za-z0-9_]+)?/gu)) {
        reads.push(`${file}:${id}:${match[0]}`);
      }
    }
  }
  assert.deepEqual(reads, ['ci.yml:deploy:secrets.DISPATCH_APP_KEY']);
});

test('Deploy runs only on a push to main, in production, with no permission and no repository code', () => {
  const deploy = job('deploy');
  assert.match(
    deploy,
    /^ {4}if: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}$/mu,
  );
  assert.match(deploy, /^ {4}needs: publish$/mu);
  assert.match(deploy, /^ {4}runs-on: ubuntu-[0-9.]+$/mu, 'a GitHub-hosted runner');
  assert.match(deploy, /^ {4}environment: production$/mu);
  assert.match(deploy, /^ {4}permissions: \{\}$/mu);
  assert.match(deploy, /^ {4}timeout-minutes: 90$/mu);

  const deploySteps = steps(deploy);
  const uses = deploySteps.flatMap((step) => [...step.matchAll(/uses: (\S+)@/gu)].map((m) => m[1]));
  assert.deepEqual(uses, ['actions/create-github-app-token'], 'no checkout, no other action');
  const [token, ...scripts] = deploySteps;
  for (const input of [
    /client-id: \$\{\{ vars\.DISPATCH_APP_CLIENT_ID \}\}/u,
    /private-key: \$\{\{ secrets\.DISPATCH_APP_KEY \}\}/u,
    /owner: siddak1234$/mu,
    /repositories: snoopy-backend$/mu,
  ]) {
    assert.match(token!, input);
  }
  // The token's one permission (ci.yml's header): without a permission-* input the token
  // would carry every permission the App's installation grants.
  assert.deepEqual(
    [...token!.matchAll(/^ {10}(permission-[a-z-]+): (\S+)$/gmu)].map((m) => `${m[1]}: ${m[2]}`),
    ['permission-actions: write'],
    'the token asks for Actions write and nothing else',
  );
  for (const step of scripts) {
    const script = step.split(/^ {8}run: \|\s*$/mu)[1];
    assert.ok(script !== undefined, 'every other step is a run script');
    assert.doesNotMatch(script, /\$\{\{/u, 'values reach a script only through env');
    assert.doesNotMatch(script, /(^|[\s;|&(])(npm|npx|node|tsx|bash|sh|source)\s|\.\//mu);
  }
  const text = scripts.join('\n');
  assert.match(text, /actions\/workflows\/flow-cd\.yml\/dispatches/u);
  assert.match(text, /-f ref=main -f "inputs\[sha\]=\$SHA" -F return_run_details=true/u);
  assert.match(text, /SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(text, /gh run watch "\$RUN_ID" --repo siddak1234\/snoopy-backend --exit-status/u);
  assert.match(
    text,
    /gh run download "\$RUN_ID" --repo siddak1234\/snoopy-backend --name flow-cd-result/u,
  );
  assert.match(text, /jq \. "\$dir\/result\.json"/u, 'it prints result.json');
  assert.match(text, /jq -r \.ok "\$dir\/result\.json"\)" != true \]; then[^]*?exit 1/u);
});

test('Publish attests each digest after both scans and before the tag', () => {
  const publishSteps = steps(job('publish'));
  const at = (pattern: RegExp) =>
    publishSteps.flatMap((step, index) => (pattern.test(step) ? [index] : []));
  const scans = at(/uses: aquasecurity\/trivy-action@/u);
  const attests = at(/uses: actions\/attest@/u);
  const tags = at(/^name: Tag the proven digest/u);
  assert.equal(scans.length, 2, 'two Trivy passes');
  assert.equal(attests.length, 1, 'one attestation step');
  assert.equal(tags.length, 1, 'one tag step');
  assert.ok(Math.max(...scans) < attests[0]!, 'the attestation comes after both scans');
  assert.ok(attests[0]! < tags[0]!, 'the attestation comes before the tag');
  const attest = publishSteps[attests[0]!]!;
  assert.match(attest, /subject-name: \$\{\{ env\.IMAGE_NAME \}\}/u);
  assert.match(attest, /subject-digest: \$\{\{ steps\.publish\.outputs\.digest \}\}/u);
  assert.match(attest, /push-to-registry: true/u);
});

test('id-token, attestations and packages write are Publish’s alone, and the nightly’s call grants them only as its ceiling', () => {
  assert.match(
    code(ci.split(/^jobs:\s*$/mu)[0]!),
    /^permissions:\n {2}contents: read\n(?! )/mu,
    'the workflow default is contents: read',
  );
  for (const file of workflowFiles) {
    assert.doesNotMatch(
      code(read(file)),
      /^\s*permissions:\s*(write-all|read-all)\b/mu,
      `${file} grants write-all or read-all`,
    );
    for (const [id, block] of jobs(read(file))) {
      // GitHub refuses a call whose called jobs ask for more than the caller grants, so the
      // nightly's call to ci.yml grants Publish's; the call runs nothing of its own.
      const call = file === 'nightly.yml' && id === 'ci';
      if (call) assert.match(block, /^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/mu);
      for (const permission of ['id-token', 'attestations', 'packages']) {
        const writes = new RegExp(`^\\s+${permission}: write$`, 'mu').test(block);
        assert.equal(
          writes,
          (file === 'ci.yml' && id === 'publish') || call,
          `${file}:${id} ${permission}`,
        );
      }
    }
  }
});

test('no matrix is written by hand: List reads automations/*/Dockerfile', () => {
  const list = job('list');
  assert.match(list, /for dockerfile in automations\/\*\/Dockerfile; do/u);
  assert.match(list, /automations: \$\{\{ steps\.list\.outputs\.automations \}\}/u);
  assert.match(list, /images: \$\{\{ steps\.images\.outputs\.images \}\}/u);
  assert.match(list, /images="\$\(node scripts\/changed-images\.mjs --base "\$BASE"\)"/u);
  assert.match(list, /images="\$AUTOMATIONS"/u, 'a push builds every flow');
  let matrices = 0;
  for (const file of workflowFiles) {
    for (const [id, block] of jobs(read(file))) {
      const matrix = block.split(/^ {6}matrix:\s*$/mu)[1];
      if (matrix === undefined) continue;
      matrices += 1;
      const lines = matrix.split('\n').filter((line) => line.trim() !== '');
      const end = lines.findIndex((line) => !/^ {8}/u.test(line));
      const entries = lines.slice(0, end === -1 ? lines.length : end);
      // Image builds List's `images` (the flows whose image inputs changed, on a pull request),
      // Publish every automation List read.
      const output = file === 'ci.yml' && id === 'image' ? 'images' : 'automations';
      assert.deepEqual(
        entries,
        [`        automation: \${{ fromJSON(needs.list.outputs.${output}) }}`],
        `${file}:${id}`,
      );
      assert.match(block, /^ {4}needs: (list|\[list(, [a-z-]+)*\])$/mu, `${file}:${id} needs list`);
    }
  }
  assert.equal(matrices, 2, 'Image and Publish');
});

test('every action is pinned by a full commit SHA', () => {
  let count = 0;
  for (const file of workflowFiles) {
    for (const line of read(file).split('\n')) {
      const uses = /^\s*-?\s*uses:\s*(.*)$/u.exec(line);
      if (!uses) continue;
      // The nightly's call to ci.yml is this repository's own file at the same commit.
      if (file === 'nightly.yml' && uses[1] === './.github/workflows/ci.yml') continue;
      count += 1;
      assert.match(
        uses[1]!,
        /^[\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/u,
        `${file}: ${line}`,
      );
    }
  }
  assert.ok(count > 0);
});

test('all-green needs every job, and lets only Publish and Deploy skip off a push and an empty Image on a pull request', () => {
  const allGreen = job('all-green');
  const needs = /^ {4}needs: \[([^\]]*)\]$/mu.exec(allGreen)?.[1]?.split(/,\s*/u);
  assert.deepEqual(
    needs?.sort(),
    [...ciJobs.keys()].filter((id) => id !== 'all-green').sort(),
    'all-green names every job',
  );
  assert.match(allGreen, /^ {4}if: always\(\)$/mu);
  assert.match(
    allGreen,
    /if \{ \[ "\$job" = publish \] \|\| \[ "\$job" = deploy \]; \} && \[ "\$EVENT_NAME" != push \]; then\n {18}verdict='ok \(push-only job, skipped off a push\)'$/mu,
  );
  // Image may skip only on a pull request whose List found no flow to build.
  assert.match(
    allGreen,
    /elif \[ "\$job" = image \] && \[ "\$IMAGES" = '\[\]' \] && \[ "\$EVENT_NAME" = pull_request \]; then/u,
  );
  assert.match(job('image'), /^ {4}if: \$\{\{ needs\.list\.outputs\.images != '\[\]' \}\}$/mu);
});

test('every job has a time limit but the nightly’s call to ci.yml, which GitHub allows none', () => {
  let calls = 0;
  for (const file of workflowFiles) {
    for (const [id, block] of jobs(read(file))) {
      const call = /^ {4}uses: /mu.test(block);
      if (call) calls += 1;
      const limit = /^ {4}timeout-minutes: [1-9]\d*$/mu.test(block);
      assert.equal(limit, !call, `${file}:${id} ${call ? 'is a call' : 'has no time limit'}`);
    }
  }
  assert.equal(calls, 1, 'the nightly’s call');
});

test('Verify fails when a test skipped or was left todo, reading the whole log', () => {
  const verify = steps(job('verify')).find((step) => /^name: Verify formatting/u.test(step));
  assert.ok(verify !== undefined, 'the Verify step');
  assert.match(verify, /^ {10}set -o pipefail$/mu, 'a red verify stays red through tee');
  assert.match(verify, /^ {10}npm run verify \| tee "\$RUNNER_TEMP\/verify\.log"$/mu);
  assert.match(
    verify,
    /^ {10}if grep -qE '\^# \(skipped\|todo\) \[1-9\]' "\$RUNNER_TEMP\/verify\.log"; then\n {12}echo '[^'\n]+'\n {12}exit 1$/mu,
  );
});

const nightly = read('nightly.yml');
const nightlyJobs = jobs(nightly);

test("the nightly is its own workflow: a schedule calling ci.yml whole, and ci.yml carries no schedule (GitHub's 60-day rule)", () => {
  const triggers = (text: string) =>
    code(text.split(/^jobs:\s*$/mu)[0]!).split(/^permissions:/mu)[0]!;
  assert.match(triggers(nightly), /^ {2}schedule:\n {4}- cron: '[0-9*,/ -]+'$/mu);
  assert.doesNotMatch(
    triggers(nightly),
    /^ {2}(push|pull_request):/mu,
    'the nightly is not a gate',
  );
  assert.match(code(nightly), /^permissions: \{\}$/mu, 'no permission by default');
  // A disabled schedule stops only nightly.yml; the merge gate has none to lose.
  assert.match(triggers(ci), /^ {2}workflow_call:$/mu);
  assert.doesNotMatch(triggers(ci), /^ {2}schedule:/mu);
  assert.deepEqual([...nightlyJobs.keys()], ['ci', 'report']);
  const call = nightlyJobs.get('ci')!;
  assert.match(call, /^ {4}uses: \.\/\.github\/workflows\/ci\.yml$/mu);
  assert.doesNotMatch(call, /^ {4}(with|secrets|steps|runs-on):/mu, 'ci.yml whole, as it is');
});

test('Nightly red reports a red night on its own issue, with issues: write alone, no checkout and no code of this repository', () => {
  const report = nightlyJobs.get('report');
  assert.ok(report !== undefined, 'nightly.yml has a report job');
  assert.match(report, /^ {4}name: Nightly red$/mu);
  assert.match(report, /^ {4}needs: ci$/mu);
  assert.match(report, /^ {4}if: always\(\) && needs\.ci\.result != 'success'$/mu);
  assert.match(report, /^ {4}runs-on: ubuntu-[0-9.]+$/mu);
  assert.match(report, /^ {4}permissions:\n {6}issues: write\n(?! {6})/mu, 'issues: write alone');
  assert.doesNotMatch(report, /\buses:/u, 'no checkout, no action');
  const [script] = steps(report).map((step) => step.split(/^ {8}run: \|\s*$/mu)[1]);
  assert.ok(script !== undefined, 'one run script');
  assert.doesNotMatch(script, /\$\{\{/u, 'values reach the script only through env');
  assert.doesNotMatch(script, /(^|[\s;|&(])(npm|npx|node|tsx|bash|sh|source)\s|\.\//mu);
  assert.match(report, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(script, /gh issue create --title 'Nightly red'/u);
  assert.match(script, /gh issue comment "\$number"/u, 'a red night already open is commented on');
  // Only an issue this workflow's token opened is commented on, never a stranger's with the title.
  const lookups = [...script.matchAll(/gh issue list ([^\n]*)/gu)].map((match) => match[1]!);
  assert.equal(lookups.length, 1, 'one lookup');
  assert.match(lookups[0]!, /^--state open --author 'github-actions\[bot\]' /u);
  assert.match(script, /select\(\.title == "Nightly red"\)/u);
});
