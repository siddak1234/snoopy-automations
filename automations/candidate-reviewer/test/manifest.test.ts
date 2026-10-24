import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SERVED_VERSIONS, TEMPLATE_ID } from '../src/automation.js';
import { FILE_LIMITS } from '../src/file.js';
import { EXTRACT_POSTING, EXTRACT_RESUME, PROMPTS, SCORE_CANDIDATE } from '../src/prompts.js';
import { RESUME_FILE_KEY } from '../src/steps/candidate.js';
import { JOB_FILE_KEY } from '../src/steps/job.js';
import { manifest } from './fixtures.js';

/**
 * `manifests/candidate-reviewer.v1.json` as the spec words it (§1–§7): its name and department,
 * its one question, the files it takes, its four steps and five, its jobs, and its container —
 * and the code's constants held to it.
 */

type Entry = Record<string, unknown>;
const m = manifest as unknown as Record<string, Entry & Entry[]>;
const items = manifest.items as unknown as Entry & { fields: Entry[]; pipeline: Entry[] };

test('§1: Candidate Reviewer, in HR, free, drawn with UserPlus', () => {
  assert.equal(m.templateId, TEMPLATE_ID);
  assert.deepEqual([m.version], SERVED_VERSIONS);
  assert.deepEqual(m.display, {
    name: 'Candidate Reviewer',
    description: 'Reads resumes and scores each candidate against the job posting.',
    category: 'HR',
    icon: 'UserPlus',
  });
  assert.deepEqual(m.pricing, { monthlyPriceUsd: 0 });
});

test('§2–§5: started by hand with a resume; PDF, JPEG, PNG or Word; no connection, no setup', () => {
  assert.deepEqual(m.trigger, {
    kind: 'manual',
    input: [
      {
        key: RESUME_FILE_KEY,
        title: 'Resume',
        description: 'A PDF, Word file or photo.',
        control: 'artifact',
        // The spec's "yes": the platform refuses a required file field, so the run asks for it.
        required: false,
      },
    ],
  });
  assert.deepEqual(m.artifacts, FILE_LIMITS, 'no page or pixel limit: Word is not measured');
  assert.deepEqual([m.requiredConnections, m.setup], [[], []]);
  const capabilities = new Set(PROMPTS.map((prompt) => prompt.capability));
  assert.deepEqual(
    [...capabilities].sort(),
    [...(m.requiredCapabilities as unknown as string[])].sort(),
  );
  assert.deepEqual(
    [EXTRACT_POSTING, EXTRACT_RESUME, SCORE_CANDIDATE].map((p) => [p.id, p.capability]),
    [
      ['extract-posting', 'document-extraction'],
      ['extract-resume', 'document-extraction'],
      ['score-candidate', 'screening'],
    ],
  );
});

test("§6: four steps a person sees, five a run reports, the email the platform's", () => {
  assert.deepEqual(
    (m.groups as Entry[]).map((group) => [
      group.id,
      group.title,
      group.description,
      group.platform,
    ]),
    [
      ['upload', 'Add candidate', 'A resume: PDF, Word file or photo.', undefined],
      ['review', 'AI review', 'Reads the resume and scores it.', undefined],
      ['ranked', 'Candidates ranked', 'Highest score first.', undefined],
      ['email', 'Run completed', 'Done when the run succeeds.', 'email'],
    ],
  );
  assert.deepEqual(
    (m.pipeline as Entry[]).map((step) => [step.id, step.kicker, step.group, step.title]),
    [
      ['receive', 'TRIGGER', 'upload', 'Resume received'],
      ['read-resume', 'AI STEP', 'review', 'Resume read'],
      ['check-resume', 'ACTION', 'review', 'Resume checked'],
      ['score', 'AI STEP', 'review', 'Candidate scored'],
      ['save', 'ACTION', 'ranked', 'Candidate saved'],
    ],
  );
});

test('§2 and §6: jobs — a department from the sixteen, or typed; a role; the file; three steps', () => {
  assert.deepEqual(
    [items.words, items.runWords],
    [
      { singular: 'Job', plural: 'Jobs' },
      { singular: 'Candidate', plural: 'Candidates' },
    ],
  );
  assert.deepEqual([items.titleField, items.groupField], ['role', 'department']);
  const [department, role] = items.fields as [Entry, Entry];
  assert.deepEqual(department.options, [
    'HR',
    'Accounting',
    'Finance',
    'Legal',
    'Compliance',
    'Data',
    'Operations',
    'Sales',
    'Marketing',
    'Customer Support',
    'IT',
    'Engineering',
    'Product',
    'Procurement',
    'Administration',
    'Research',
  ]);
  assert.deepEqual(
    [department.control, department.allowOther, department.defaultValue, department.required],
    ['select', true, 'HR', true],
  );
  assert.deepEqual(role, {
    key: 'role',
    title: 'Role',
    control: 'text',
    maxLength: 80,
    required: true,
  });
  assert.deepEqual(items.file, {
    key: JOB_FILE_KEY,
    title: 'Job description',
    description: 'A PDF, Word file or photo.',
  });
  assert.deepEqual(
    items.pipeline.map((step) => [step.id, step.title]),
    [
      ['job-received', 'Job description received'],
      ['read-job', 'Job read'],
      ['save-job', 'Job saved'],
    ],
  );
});

test("the job's reading is the posting prompt's answer less whether it was readable", () => {
  const prompt = EXTRACT_POSTING.outputSchema as { properties: Entry; required: string[] };
  const reading = items.outputSchema as { properties: Entry; required: string[] };
  const { readable: _readable, ...read } = prompt.properties;
  assert.deepEqual(reading.properties, read);
  assert.deepEqual(
    reading.required,
    prompt.required.filter((key) => key !== 'readable'),
  );
});

test('§1: its own container and service account, as v7 of Invoice Processing set them', () => {
  assert.deepEqual(m.service, {
    origin: 'http://candidate-reviewer-v1.autom8x.internal:8080',
    serviceAccount: 'candidate-reviewer-v1@autom8x.iam.gserviceaccount.com',
    contractVersion: 1,
    maxConcurrentRuns: 1,
    acceptTimeoutMs: 5000,
    runTimeoutSeconds: 900,
  });
});
