import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { docxText } from '../automations/candidate-reviewer/src/docx.js';
import { partAnswerOf } from '../automations/invoice-processing/src/run/answer.js';
import { documentReadOf } from '../automations/invoice-processing/src/run/document-read.js';
import { recordingOf } from '../automations/invoice-processing/test/recordings.js';
import { SAMPLES } from '../automations/invoice-processing/test/sample-maker/samples.js';
import { ENV, main, type Io } from '../scripts/live-eval.js';
import { PROFILES, type Profile } from '../scripts/live-eval/profiles.js';
import { CANDIDATES, sha256 } from '../scripts/live-eval/resumes.js';
import { API, ENV_FOR, WORKSPACE, fakePlatform, type FakeOptions } from './live-eval-fake.js';

/**
 * `npm run live-eval` (Round 21, Stage 2, the owner's Q4), against a fake platform — CI never calls
 * a model: 25 invented samples through the platform's public API, each run's key fields compared
 * with its recording field by field, every difference printed, a pass only when all match; the
 * recording mode; the job a pass makes, archived when it ends; and what it refuses before anything
 * runs. The session never reaches a line, a recording or the store.
 */

const INVOICE = PROFILES['invoice-processing']!;
const RESUMES = PROFILES['candidate-reviewer']!;

/** A profile whose recordings go to a fresh folder, removed by `done`. */
function scratch(profile: Profile) {
  const folder = mkdtempSync(join(tmpdir(), 'autom8x-live-eval-'));
  return {
    profile: { ...profile, recordings: folder },
    done: () => rmSync(folder, { recursive: true, force: true }),
    folder,
  };
}

async function evaluate(
  argv: string[],
  fake: FakeOptions,
  profiles: Record<string, Profile> = PROFILES,
  env = ENV_FOR(),
) {
  const platform = fakePlatform(fake);
  const lines: string[] = [];
  const io: Io = {
    fetch: platform.fetch,
    sleep: () => Promise.resolve(),
    write: (line) => void lines.push(line),
    now: () => new Date('2026-11-04T12:00:00Z'),
    profiles,
  };
  const code = await main(argv, env, io);
  return { code, lines, sent: platform.sent };
}

/** The calls that archived the job, and whether each came after every run was started. */
function archivesOf(sent: readonly { method: string; url: string }[]) {
  const lastRun = sent.map((call) => call.url.endsWith('/runs')).lastIndexOf(true);
  return sent
    .map((call, at) => ({ call, at }))
    .filter(({ call }) => call.method === 'POST' && call.url.endsWith('/archive'))
    .map(({ call, at }) => ({ url: call.url, afterRuns: at > lastRun }));
}

/** The documents a run of each sample shows, as the agents' first read gives them: by file name. */
const READ_DOCUMENTS = new Map(
  SAMPLES.map((sample) => {
    const part = partAnswerOf(JSON.parse(recordingOf(sample)!.text))!;
    const documents = part.documents.map(documentReadOf).map((read) => ({
      vendor: { name: read.vendor.name },
      number: read.number,
      total: read.total,
    }));
    return [sample.name, documents] as const;
  }),
);

/** A run's page by its file's name — the sample's, and its type — its first document `change`d. */
const invoicePage =
  (change: (sample: string) => Record<string, unknown> | undefined = () => undefined) =>
  (filename: string) => {
    const sample = filename.replace(/\.[a-z]+$/u, '');
    const documents = READ_DOCUMENTS.get(sample) ?? [];
    const changed = change(sample);
    return {
      documents: changed ? [{ ...documents[0], ...changed }, ...documents.slice(1)] : documents,
    };
  };

const INVOICE_FAKE = { templateId: 'invoice-processing', version: 8, config: { vendor: 'none' } };

test("Invoice Processing: 25 samples, each run's supplier, number and total matching the agents' recorded first read: PASS, exit 0", async () => {
  assert.equal(INVOICE.samples().length, 25);
  const { code, lines, sent } = await evaluate(['invoice-processing'], {
    ...INVOICE_FAKE,
    pageOf: invoicePage(),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(lines.at(-1), '25 of 25 match: PASS');
  assert.equal(
    sent.filter((call) => call.method === 'POST' && call.url.endsWith('/runs')).length,
    25,
  );
  assert.deepEqual(archivesOf(sent), [], 'no job made, none archived');
});

test('a key field that differs fails the eval, exit 1, and prints the sample, the field and both values', async () => {
  const { code, lines } = await evaluate(['invoice-processing'], {
    ...INVOICE_FAKE,
    pageOf: invoicePage((sample) => (sample === 'receipt' ? { total: '60.36' } : undefined)),
  });
  assert.equal(code, 1);
  assert.ok(lines.includes("receipt: 1 differ, against the agents' first read"), lines.join('\n'));
  assert.ok(lines.includes('  document 1 total: recorded "60.63", live "60.36"'), lines.join('\n'));
  assert.equal(lines.at(-1), '24 of 25 match: FAIL');
});

test('Resume Screening: --record makes its job first, then 25 recordings from live runs; compared after, they pass; a run that fails is a difference', async () => {
  const { profile, done, folder } = scratch(RESUMES);
  try {
    const page = (filename: string) => {
      const candidate = CANDIDATES.find((each) => `${each.sample}.docx` === filename)!;
      // v4's blocks: one group, its Contact a `{ title: label, text: value }` row each, then links.
      return {
        run: { title: candidate.name },
        blocks: [
          {
            type: 'group',
            title: 'Candidate details',
            blocks: [
              {
                type: 'section',
                title: 'Contact',
                blocks: [
                  {
                    type: 'list',
                    items: [
                      { title: 'Name', text: candidate.name },
                      { title: 'Email', text: candidate.email },
                      ...(candidate.phone === ''
                        ? []
                        : [{ title: 'Phone', text: candidate.phone }]),
                    ],
                  },
                  { type: 'links', items: [] },
                ],
              },
              { type: 'section', title: 'Skills', blocks: [{ type: 'list', items: [] }] },
            ],
          },
        ],
      };
    };
    const fake = { templateId: 'candidate-reviewer', version: 4, pageOf: page };
    const profiles = { 'candidate-reviewer': profile };
    const recorded = await evaluate(['candidate-reviewer', '--record'], fake, profiles);
    assert.equal(recorded.code, 0, recorded.lines.join('\n'));
    assert.equal(recorded.lines.at(-1), '25 of 25 recorded: PASS');
    const items = recorded.sent.filter((call) => call.url.endsWith('/items'));
    assert.equal(items.length, 1, 'the job, once, before any candidate');
    assert.deepEqual(JSON.parse(items[0]!.body!).fields, RESUMES.job!.fields);
    assert.deepEqual(
      archivesOf(recorded.sent),
      [{ url: `${API}/v1/workspaces/${WORKSPACE}/items/item-1/archive`, afterRuns: true }],
      'the job archived once, when the pass ends',
    );
    const archive = recorded.sent.find((call) => call.url.endsWith('/archive'))!;
    assert.match(archive.headers['idempotency-key']!, /^live-eval-[0-9a-f-]{36}$/u);
    assert.equal(archive.body, undefined, 'its body empty');
    const files = readdirSync(folder).sort();
    assert.equal(files.length, 25);
    const first = JSON.parse(readFileSync(join(folder, files[0]!), 'utf8'));
    assert.deepEqual(first.fields, {
      name: CANDIDATES[0]!.name,
      email: CANDIDATES[0]!.email,
      phone: CANDIDATES[0]!.phone,
    });
    assert.equal(first.templateVersion, 4);
    const reads = recorded.sent.filter((call) => /\/runs\/run-\d+/u.test(call.url));
    assert.ok(
      reads.length > 0 && reads.every((call) => call.url.endsWith('?shape=blocks')),
      'each run read with shape=blocks: a read without it carries no blocks',
    );

    assert.equal((await evaluate(['candidate-reviewer'], fake, profiles)).code, 0);
    const failing = await evaluate(
      ['candidate-reviewer'],
      {
        ...fake,
        pageOf: (filename) =>
          filename === 'candidate-07.docx'
            ? {
                run: {
                  status: 'failed',
                  failureReason: "The AI's answer couldn't be used. Try a clearer file.",
                },
              }
            : page(filename),
      },
      profiles,
    );
    assert.equal(failing.code, 1);
    assert.ok(
      failing.lines.includes(
        "candidate-07: the run failed: The AI's answer couldn't be used. Try a clearer file.",
      ),
      failing.lines.join('\n'),
    );
    assert.equal(archivesOf(failing.sent).length, 1, 'a failed pass archives its job too');
  } finally {
    done();
  }
});

test("Resume Screening's job is archived however the pass ends: stopped by a run that never ends, or by a job whose file failed; an archive refused is a line, the pass's exit kept", async () => {
  const { profile, done } = scratch(RESUMES);
  try {
    const profiles = { 'candidate-reviewer': profile };
    const page = (filename: string) => {
      const candidate = CANDIDATES.find((each) => `${each.sample}.docx` === filename)!;
      return { run: { title: candidate.name }, blocks: [] };
    };
    const fake = { templateId: 'candidate-reviewer', version: 4, pageOf: page };

    const stopped = await evaluate(
      ['candidate-reviewer', '--record'],
      {
        ...fake,
        pageOf: (filename) =>
          filename === 'candidate-03.docx' ? { run: { status: 'running' } } : page(filename),
      },
      profiles,
    );
    assert.equal(stopped.code, 2, stopped.lines.join('\n'));
    assert.match(
      stopped.lines.at(-1)!,
      /^live eval stopped: run run-\d+ had not ended after 600 s$/u,
    );
    assert.deepEqual(
      archivesOf(stopped.sent).map((each) => each.afterRuns),
      [true],
      'archived once, after the pass stopped',
    );

    const unread = await evaluate(
      ['candidate-reviewer', '--record'],
      { ...fake, itemStatus: 'failed' },
      profiles,
    );
    assert.equal(unread.code, 2);
    assert.equal(unread.lines.at(-1), 'live eval stopped: the job could not be made from its file');
    assert.equal(unread.sent.filter((call) => call.url.endsWith('/runs')).length, 0);
    assert.equal(archivesOf(unread.sent).length, 1, 'a job whose file failed is archived too');

    const refused = await evaluate(
      ['candidate-reviewer', '--record'],
      { ...fake, archiveStatus: 403 },
      profiles,
    );
    assert.equal(refused.code, 0, refused.lines.join('\n'));
    assert.ok(
      refused.lines.includes(
        "the job item-1 was not archived (POST /items/item-1/archive answered 403); it stays in the flow's list",
      ),
      refused.lines.join('\n'),
    );
  } finally {
    done();
  }
});

test('with no recording, compare mode runs nothing for that sample and fails it: "run with --record first"', async () => {
  const { profile, done } = scratch(RESUMES);
  try {
    const { code, lines, sent } = await evaluate(
      ['candidate-reviewer'],
      { templateId: 'candidate-reviewer', version: 4, pageOf: () => ({}) },
      { 'candidate-reviewer': profile },
    );
    assert.equal(code, 1);
    assert.ok(lines.includes('candidate-01: no recording; run with --record first'));
    assert.equal(sent.filter((call) => call.url.endsWith('/runs')).length, 0);
  } finally {
    done();
  }
});

test('refused before anything runs, exit 2: in CI, without its session, off https, another flow or version, a stopped flow, QuickBooks chosen', async () => {
  const cases: [string[], Partial<FakeOptions>, Record<string, string | undefined>, RegExp][] = [
    [['invoice-processing'], {}, { CI: 'true' }, /never in CI/u],
    [['invoice-processing'], {}, { [ENV.session]: undefined }, /set AUTOM8X_EVAL_SESSION/u],
    [['invoice-processing'], {}, { [ENV.api]: 'http://api.autom8x.test' }, /https origin/u],
    [
      ['invoice-processing'],
      { templateId: 'candidate-reviewer' },
      {},
      /candidate-reviewer's, not/u,
    ],
    [['invoice-processing'], { version: 7 }, {}, /pins v7; the eval is for v8/u],
    [
      ['candidate-reviewer'],
      { templateId: 'candidate-reviewer', version: 3 },
      {},
      /pins v3; the eval is for v4/u,
    ],
    [['invoice-processing'], { status: 'paused' }, {}, /paused, not live/u],
    [
      ['invoice-processing'],
      { config: { vendor: 'quickbooks' } },
      {},
      /never writes to QuickBooks/u,
    ],
    [['ledger-sync'], {}, {}, /no live eval for ledger-sync/u],
    [['invoice-processing', '--fast'], {}, {}, /^usage: npm run live-eval/u],
  ];
  for (const [argv, fake, env, words] of cases) {
    const { code, lines, sent } = await evaluate(
      argv,
      { ...INVOICE_FAKE, pageOf: invoicePage(), ...fake },
      PROFILES,
      ENV_FOR(env),
    );
    assert.equal(code, 2, `${words}`);
    assert.match(lines.join('\n'), words);
    assert.equal(sent.filter((call) => call.method === 'POST').length, 0, `${words}: nothing run`);
  }
});

test('the session is sent only as the bearer to the API — never to the store, a line or a recording', async () => {
  const { profile, done, folder } = scratch(INVOICE);
  try {
    const { lines, sent } = await evaluate(
      ['invoice-processing', '--record'],
      { ...INVOICE_FAKE, pageOf: invoicePage() },
      { 'invoice-processing': profile },
    );
    const secret = ENV_FOR()[ENV.session]!;
    for (const call of sent) {
      const toStore = call.url.startsWith('https://store.test/');
      assert.equal(call.headers.authorization, toStore ? undefined : `Bearer ${secret}`, call.url);
      assert.ok(!call.url.includes(secret) && !(call.body ?? '').includes(secret));
    }
    assert.ok(!lines.join('\n').includes(secret));
    for (const file of readdirSync(folder)) {
      assert.ok(!readFileSync(join(folder, file), 'utf8').includes(secret), file);
    }
    const keys = sent.filter((call) => call.url.endsWith('/runs') && call.method === 'POST');
    assert.ok(
      keys.every((call) => /^live-eval-[0-9a-f-]{36}$/u.test(call.headers['idempotency-key']!)),
    );
  } finally {
    done();
  }
});

test("the samples are invented: Resume Screening's 25 people at example.com with 555-01xx phones, each its own; Invoice Processing's its 25 made-up files", () => {
  assert.equal(CANDIDATES.length, 25);
  assert.equal(new Set(CANDIDATES.map((each) => each.name)).size, 25);
  for (const candidate of CANDIDATES) {
    assert.match(candidate.email, /@example\.com$/u);
    assert.match(candidate.phone, /^(\+1 555 01\d\d)?$/u);
  }
  assert.deepEqual(
    INVOICE.samples().map((sample) => sample.name),
    SAMPLES.map((sample) => sample.name),
  );
});

/** The sha256 of the 25 resumes' and the job's sha256s, one a line: what their recordings name. */
const RESUME_BYTES = 'bfdf1ddcfa28d45afc1a8ab2d7bc567a765c940b01f4ad0a0bbd05fbc69f784b';

test("Resume Screening's Word files are the format's own bytes: each entry deflate's stored blocks, its words in the file as written, the same on every zlib, and the flow's own reader reads each", () => {
  const files = [...RESUMES.samples().map((sample) => sample.file()), RESUMES.job!.file()];
  for (const [at, candidate] of CANDIDATES.entries()) {
    const { bytes } = files[at]!;
    for (const words of [candidate.name, candidate.email, candidate.phone].filter(Boolean)) {
      assert.ok(Buffer.from(bytes).includes(words), `${candidate.sample}: "${words}" as written`);
    }
    const read = docxText(bytes);
    assert.ok(read.ok, `${candidate.sample}: ${read.ok ? '' : read.refusal}`);
    assert.ok(read.text.includes(candidate.name) && read.text.includes(candidate.email));
  }
  const job = docxText(files.at(-1)!.bytes);
  assert.ok(job.ok && job.text.includes('Must have: a CPA license'));
  assert.equal(
    sha256(Buffer.from(files.map((file) => sha256(file.bytes)).join('\n'))),
    RESUME_BYTES,
    "the samples' bytes moved: their recordings must be made again (--record)",
  );
});
