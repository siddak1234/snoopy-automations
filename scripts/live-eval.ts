// `npm run live-eval -- <templateId> [--record]` (Round 21, Stage 2, the owner's Q4): the command the
// session runs when a flow's prompt version or model list changes. It runs the flow's 25 invented
// samples through the LIVE platform, in a test workspace, on the platform's own model key — each
// uploaded, run and read as a person's app does — and compares each run's key fields with its
// recording, field by field: it passes only when every key field of every sample matches, and
// prints each difference for the owner. `--record` makes the recordings from the live runs instead.
// A flow with items makes its job first and archives it when the pass ends. The test workspace's
// session is read from the environment at run time (`ENV`), never written; CI never runs it (it
// refuses when `CI` is set), and the suite runs it against a fake platform.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EvalError,
  archiveItem,
  endedRun,
  makeItem,
  readSubscription,
  readyItem,
  startRun,
  upload,
  type Fetch,
  type Live,
} from './live-eval/client.js';
import {
  PROFILES,
  baselineOf,
  recordingPath,
  type Fields,
  type Profile,
  type Recording,
} from './live-eval/profiles.js';
import { sha256 } from './live-eval/resumes.js';

/** The environment the eval reads, by what each holds. */
export const ENV = {
  api: 'AUTOM8X_EVAL_API_URL',
  session: 'AUTOM8X_EVAL_SESSION',
  workspace: 'AUTOM8X_EVAL_WORKSPACE_ID',
  subscription: 'AUTOM8X_EVAL_SUBSCRIPTION_ID',
} as const;

export const USAGE = `usage: npm run live-eval -- <${Object.keys(PROFILES).join('|')}> [--record]`;

/** Between two reads of a run, and the most one run may take. */
export const POLL_MS = 5_000;
export const RUN_TIMEOUT_MS = 10 * 60_000;

/** What the eval is handed: the network, a clock, where it prints — and, for the suite, its flows. */
export interface Io {
  readonly fetch: Fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly write: (line: string) => void;
  readonly now: () => Date;
  readonly profiles?: Readonly<Record<string, Profile>>;
}

/** Each key field the recording and the live run do not hold alike: its name, then both values. */
export function differences(
  recorded: Fields,
  live: Fields,
): [field: string, recorded: string | null, live: string | null][] {
  const names = [...new Set([...Object.keys(recorded), ...Object.keys(live)])];
  return names
    .filter((name) => (recorded[name] ?? null) !== (live[name] ?? null))
    .map((name) => [name, recorded[name] ?? null, live[name] ?? null]);
}

const shown = (value: string | null) => (value === null ? 'none' : JSON.stringify(value));

/** The API's origin, or undefined when it is neither https nor this machine's own http. */
function originOf(text: string): string | undefined {
  const api = text.replace(/\/+$/u, '');
  return /^https:\/\/[^/\s]+$/u.test(api) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(api)
    ? api
    : undefined;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: Io,
): Promise<number> {
  const profiles = io.profiles ?? PROFILES;
  const [templateId, ...flags] = argv;
  if (templateId === undefined || flags.some((flag) => flag !== '--record')) {
    io.write(USAGE);
    return 2;
  }
  const record = flags.includes('--record');
  const profile = profiles[templateId];
  if (profile === undefined) {
    io.write(`no live eval for ${templateId}; ${USAGE}`);
    return 2;
  }
  if (env.CI) {
    io.write('the live eval calls the live platform and its models: never in CI');
    return 2;
  }
  const missing = Object.values(ENV).filter((name) => !env[name]);
  if (missing.length > 0) {
    io.write(`set ${missing.join(', ')}: a test workspace's, read at run time, never written`);
    return 2;
  }
  const api = originOf(env[ENV.api]!);
  if (api === undefined) {
    io.write(`${ENV.api} must be an https origin, or http on localhost`);
    return 2;
  }
  const subscriptionId = env[ENV.subscription]!;
  const live: Live = {
    api,
    token: env[ENV.session]!,
    workspaceId: env[ENV.workspace]!,
    fetch: io.fetch,
    sleep: io.sleep,
    pollMs: POLL_MS,
    runTimeoutMs: RUN_TIMEOUT_MS,
  };
  try {
    const subscription = await readSubscription(live, subscriptionId);
    const refused =
      subscription.templateId !== profile.templateId
        ? `the subscription is ${subscription.templateId}'s, not ${profile.templateId}'s`
        : subscription.templateVersion !== profile.version
          ? `the subscription pins v${subscription.templateVersion}; the eval is for v${profile.version}`
          : subscription.status !== 'live'
            ? `the subscription is ${subscription.status}, not live`
            : profile.unsafe(subscription.config);
    if (refused !== undefined) {
      io.write(`live eval refused: ${refused}`);
      return 2;
    }
    const itemId =
      profile.job === undefined
        ? undefined
        : await makeItem(
            live,
            subscriptionId,
            profile.job.fields,
            await upload(live, subscriptionId, profile.job.file()),
          );
    try {
      if (itemId !== undefined) await readyItem(live, itemId);
      return await runSamples(profile, live, subscriptionId, itemId, record, io);
    } finally {
      if (itemId !== undefined) await archived(live, itemId, io);
    }
  } catch (error) {
    if (error instanceof EvalError) {
      io.write(`live eval stopped: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

/**
 * The pass's job archived once the pass ends — passed, failed or stopped — so no eval job stays in
 * the flow's list; one the platform does not archive is named in a line, the pass's exit kept.
 */
async function archived(live: Live, itemId: string, io: Io): Promise<void> {
  try {
    await archiveItem(live, itemId);
  } catch (error) {
    const why = error instanceof EvalError ? error.message : 'no answer read';
    io.write(`the job ${itemId} was not archived (${why}); it stays in the flow's list`);
  }
}

/** Each sample run once, in order; 0 when every one matches (or is recorded), else 1. */
async function runSamples(
  profile: Profile,
  live: Live,
  subscriptionId: string,
  itemId: string | undefined,
  record: boolean,
  io: Io,
): Promise<number> {
  const samples = profile.samples();
  io.write(
    `live eval: ${profile.templateId} v${profile.version}, ${samples.length} samples, ${record ? 'recording' : 'comparing'}`,
  );
  let passed = 0;
  for (const sample of samples) {
    const file = sample.file();
    const baseline = record ? undefined : baselineOf(profile, sample, file.bytes);
    if (!record && baseline === undefined) {
      io.write(`${sample.name}: no recording; run with --record first`);
      continue;
    }
    const artifactId = await upload(live, subscriptionId, file);
    const runId = await startRun(live, {
      subscriptionId,
      input: { [profile.fileKey]: artifactId },
      ...(itemId === undefined ? {} : { itemId }),
    });
    const detail = await endedRun(live, runId, profile.shape);
    if (detail.run.status === 'failed' || detail.run.status === 'cancelled') {
      io.write(`${sample.name}: the run ${detail.run.status}: ${detail.run.failureReason ?? ''}`);
      continue;
    }
    const fields = profile.fieldsOf(detail);
    if (record) {
      const recording: Recording = {
        sample: sample.name,
        fileSha256: sha256(file.bytes),
        templateVersion: profile.version,
        recordedAt: io.now().toISOString(),
        fields,
      };
      mkdirSync(profile.recordings, { recursive: true });
      writeFileSync(recordingPath(profile, sample.name), `${JSON.stringify(recording, null, 2)}\n`);
      io.write(`${sample.name}: recorded`);
      passed += 1;
      continue;
    }
    const differ = differences(baseline!.fields, fields);
    if (differ.length === 0) {
      io.write(`${sample.name}: match`);
      passed += 1;
      continue;
    }
    io.write(`${sample.name}: ${differ.length} differ, against ${baseline!.from}`);
    for (const [field, was, now] of differ) {
      io.write(`  ${field}: recorded ${shown(was)}, live ${shown(now)}`);
    }
  }
  const all = passed === samples.length;
  io.write(
    `${passed} of ${samples.length} ${record ? 'recorded' : 'match'}: ${all ? 'PASS' : 'FAIL'}`,
  );
  return all ? 0 : 1;
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    fetch: (url, init) => fetch(url, init),
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    write: (line) => void process.stdout.write(`${line}\n`),
    now: () => new Date(),
  });
}
