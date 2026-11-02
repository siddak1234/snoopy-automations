// `npm run verify`'s test gate (Round 21 hardening, A2): runs `npm test` — or the command it is
// given — prints its output as it comes, and fails when any suite's TAP counts a `# skipped N` or
// `# todo N` above 0, as CI's Verify step reads the whole verify log: a skipped test is a check that
// did not run. It reads TAP alone: every `tsx --test` script names its reporter
// (`--test-reporter=tap`), since Node's default is no contract (spec, not TAP, through a pipe from
// Node 23), and output with no TAP summary (`# tests N`) fails, so another format is never read as
// clean. A flow just scaffolded (`npm run scaffold`) is red here until each §9 row's test.todo is
// written.
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.length > 2 ? process.argv.slice(2) : ['npm', 'test'];
  const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    output += chunk;
  });
  child.on('error', (error) => {
    console.error(`no-skipped-tests: ${command} could not start: ${error.message}`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    if (code !== 0) {
      if (signal) console.error(`no-skipped-tests: ${command} was killed by ${signal}`);
      process.exit(code ?? 1);
    }
    if (!summarized(output)) {
      console.error(
        'no-skipped-tests: no TAP summary (`# tests N`) in the output, so no count can be read: run each `tsx --test` with --test-reporter=tap',
      );
      process.exit(1);
    }
    const found = unrun(output);
    if (found) {
      console.error(`no-skipped-tests: a test did not run (${found}): make it run, or remove it`);
      process.exit(1);
    }
  });
}
