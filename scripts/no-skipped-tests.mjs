// `npm run verify`'s test gate (Round 21 hardening, A2): runs `npm test` — or the command it is
// given — prints its output as it comes, and fails when any suite's TAP counts a `# skipped N` or
// `# todo N` above 0, as CI's Verify step reads the whole verify log: a skipped test is a check that
// did not run. It reads TAP alone: every `tsx --test` script names its reporter
// (`--test-reporter=tap`), since Node's default is no contract (spec, not TAP, through a pipe from
// Node 23), and a suite with no TAP summary (`# tests N`) fails, so another format is never read as
// clean. Each suite is read on its own (`suites`: the root's and each workspace's, cut at npm's
// banners), so one suite printing spec among TAP ones is refused. A flow just scaffolded
// (`npm run scaffold`) is red here until each §9 row's test.todo is written.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The first `# skipped N` or `# todo N` above 0 in `tap`, as `skipped N`; undefined when none. */
export function unrun(tap) {
  const counted = /^# (skipped|todo) ([1-9]\d*)/mu.exec(tap);
  return counted ? `${counted[1]} ${counted[2]}` : undefined;
}

/** Whether `output` holds a TAP run summary (`# tests N`): spec output, or none, has none. */
export function summarized(output) {
  return /^# tests \d+/mu.test(output);
}

/**
 * `output` cut into its suites: npm prints a two-line banner to stdout (`> <package> <script>`,
 * then `> <command>`) before each script it runs, so `npm test`'s own and each workspace's start
 * a suite; output with no banner is one suite, and a blank start before the first banner none.
 */
export function suites(output) {
  const parts = output.split(/^(?=> .*\n> )/mu);
  return parts.length > 1 && parts[0].trim() === '' ? parts.slice(1) : parts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.length > 2 ? process.argv.slice(2) : ['npm', 'test'];
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output += chunk;
  });
  // Every outcome sets process.exitCode and returns, never process.exit: Node then exits once
  // stdout has drained, so piped output is never cut.
  let started = true;
  child.on('error', (error) => {
    started = false;
    console.error(`no-skipped-tests: ${command} could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    if (!started) return;
    if (code !== 0) {
      if (signal) console.error(`no-skipped-tests: ${command} was killed by ${signal}`);
      process.exitCode = code ?? 1;
      return;
    }
    const bare = suites(output).find((suite) => !summarized(suite));
    if (bare !== undefined) {
      const name = /^> .*/mu.exec(bare)?.[0] ?? 'the output';
      console.error(
        `no-skipped-tests: no TAP summary (\`# tests N\`) in ${name}, so no count can be read: run each \`tsx --test\` with --test-reporter=tap`,
      );
      process.exitCode = 1;
      return;
    }
    const found = unrun(output);
    if (found) {
      console.error(`no-skipped-tests: a test did not run (${found}): make it run, or remove it`);
      process.exitCode = 1;
    }
  });
}
