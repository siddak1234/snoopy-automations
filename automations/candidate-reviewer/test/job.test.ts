import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunResult } from '@autom8x/automation-sdk';
import { declaredItemSteps, refusalFixture } from '@autom8x/automation-sdk/testing';

import {
  READING,
  WORD,
  docx,
  jobRun,
  manifestPath,
  paragraph,
  postingAnswer,
  world,
} from './fixtures.js';
import { reportedResult, rowsOf, sectionsOf, validReading } from './results.js';

/**
 * The item run — a job made from its job description (the spec's §2, §6 and §9) — on the SDK's
 * RecordingPlatform: the reading it keeps, the blocks "What AI read" shows (v4), and the job
 * description that cannot be read, in the spec's words.
 */

type Success = Extract<RunResult, { outcome: 'success' }>;

const JOB_UNREADABLE = 'The job description could not be read. Try a clearer PDF or photo.';

test('§9: a job description photo makes the posting — title, must-haves, nice-to-haves; Job saved', async () => {
  const { automation, platform } = world(
    { posting: postingAnswer() },
    { contentType: 'image/png' },
  );
  const request = jobRun();
  await platform.reportResult(request.runId, await automation.execute(request, platform));
  const result = reportedResult(platform) as Success;
  assert.equal(result.outcome, 'success');
  assert.deepEqual(result.output, READING, 'the reading is what was read, without readable');
  validReading(result.output);
  assert.deepEqual(
    platform.steps.map((step) => [step.stepId, step.summary]),
    [
      ['job-received', 'Job description received: a PDF or photo the model reads'],
      ['read-job', 'Job read: 3 must-haves, 2 nice-to-haves'],
      ['save-job', 'Job saved: 3 must-haves, 2 nice-to-haves'],
    ],
  );
  const steps = declaredItemSteps(manifestPath);
  assert.ok(
    platform.steps.every((step) => steps.has(step.stepId)),
    'items.pipeline only',
  );
  // v4: four sections at the top level, each a list; never beside sections.
  assert.equal(result.sections, undefined);
  assert.deepEqual(
    result.blocks?.map((block) => block.type),
    ['section', 'section', 'section', 'section'],
  );
  assert.deepEqual(
    sectionsOf(result).map((section) => [section.title, rowsOf(result, section.title).length]),
    [
      ['Must-haves', 3],
      ['Nice to have', 2],
      ['Responsibilities', 2],
      ['Details', 5],
    ],
  );
  assert.deepEqual(rowsOf(result, 'Must-haves')[0], { title: 'CPA license' });
  // Details: each label over its value (the owner's item 13, the same layout as Contact).
  assert.deepEqual(rowsOf(result, 'Details'), [
    { title: 'Location', text: 'Austin, TX (hybrid)' },
    { title: 'Type', text: 'Full-time' },
    { title: 'Years', text: '5 years or more' },
    { title: 'Education', text: "Bachelor's degree in accounting" },
    { title: 'Pay', text: '$85,000–$100,000 a year' },
  ]);
  assert.equal(result.summary, 'Job saved: 3 must-haves, 2 nice-to-haves');
  assert.equal(result.title, undefined, 'a job is named by its role, not by its run');
  assert.equal(result.score, undefined);
  assert.equal(result.verdict, undefined, 'a job is no candidate: the platform refuses a verdict');
});

test('a Word job description is read here and sent as text; empty sections are left out', async () => {
  const bytes = docx(paragraph('Senior Accountant') + paragraph('Must have: CPA license'));
  const sparse = postingAnswer({
    niceToHaves: [],
    responsibilities: [],
    location: '',
    employmentType: '',
    minimumYears: null,
    education: '',
    pay: '',
  });
  const { automation, platform } = world({ posting: sparse }, { ...WORD, bytes });
  const result = (await automation.execute(jobRun(), platform)) as Success;
  assert.deepEqual(platform.modelCalls[0]?.input, {
    source: 'word',
    text: 'Senior Accountant\nMust have: CPA license',
  });
  assert.deepEqual(
    sectionsOf(result).map((section) => section.title),
    ['Must-haves'],
  );
});

test("§8: a job description that cannot be read makes no job, in the spec's words", async () => {
  const unreadable = [
    postingAnswer({ readable: false }),
    // Read as readable, with nothing a candidate could be held to.
    postingAnswer({ title: '', mustHaves: [], niceToHaves: [], responsibilities: [], skills: [] }),
  ];
  for (const posting of unreadable) {
    const { automation, platform } = world({ posting });
    assert.deepEqual(await automation.execute(jobRun(), platform), {
      outcome: 'failed',
      failureReason: JOB_UNREADABLE,
    });
    assert.equal(platform.steps.at(-1)?.stepId, 'read-job');
  }
  const broken = world(
    { posting: postingAnswer() },
    { ...WORD, bytes: docx(paragraph('x'), { method: 0 }) },
  );
  assert.deepEqual(await broken.automation.execute(jobRun(), broken.platform), {
    outcome: 'failed',
    failureReason: JOB_UNREADABLE,
  });
  assert.equal(broken.platform.modelCalls.length, 0);

  const refused = world({});
  refused.platform.model = () =>
    Promise.reject(
      refusalFixture('model', {
        status: 422,
        code: 'BAD_REQUEST',
        detail: 'The file is not what its upload declared',
        details: { reason: 'file_content_mismatch' },
      }),
    );
  assert.deepEqual(await refused.automation.execute(jobRun(), refused.platform), {
    outcome: 'failed',
    failureReason: JOB_UNREADABLE,
  });
});
