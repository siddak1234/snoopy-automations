import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readManifests } from '@autom8x/automation-sdk';
import { RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { SERVED_VERSIONS, TEMPLATE_ID, define } from '../src/automation.js';
import { FILE_LIMITS } from '../src/file.js';
import { EXTRACT_POSTING, EXTRACT_RESUME, PROMPTS, SCORE_CANDIDATE } from '../src/prompts.js';
import { RESUME_FILE_KEY } from '../src/steps/candidate.js';
import { JOB_FILE_KEY } from '../src/steps/job.js';
import { NOW, candidateRun, manifest, manifestsRoot } from './fixtures.js';

/**
 * `manifests/candidate-reviewer.v2.json`, the version this image serves, as the spec words it
 * (§1–§7): its name and department, its one question, the files it takes, its four steps and
 * five, its jobs and their verdict words, and its container — and the code's constants held to
 * it; and v1, registered and immutable, as it was.
 */

type Entry = Record<string, unknown>;
const m = manifest as unknown as Record<string, Entry & Entry[]>;
const items = manifest.items as unknown as Entry & { fields: Entry[]; pipeline: Entry[] };

test('§1: Resume Screening, in HR, free, drawn with UserPlus', () => {
  assert.equal(m.templateId, TEMPLATE_ID);
  assert.deepEqual([m.version], SERVED_VERSIONS);
  assert.deepEqual(m.display, {
    name: 'Resume Screening',
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
        // The spec's "no: the platform refuses a required file field"; the run asks for it.
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
    (m.pipeline as Entry[]).map((step) => [
      step.id,
      step.kicker,
      step.group,
      step.title,
      step.description,
    ]),
    [
      ['receive', 'TRIGGER', 'upload', 'Resume received', 'A PDF, Word file or photo arrives.'],
      [
        'read-resume',
        'AI STEP',
        'review',
        'Resume read',
        'AI reads experience, education, certifications and links.',
      ],
      [
        'check-resume',
        'ACTION',
        'review',
        'Resume checked',
        'Checks it is a resume and can be read.',
      ],
      ['score', 'AI STEP', 'review', 'Candidate scored', 'Scored against the job, with reasons.'],
      [
        'save',
        'ACTION',
        'ranked',
        'Candidate saved',
        "Added to the job's list, highest score first.",
      ],
    ],
  );
});

test('§2 and §6: jobs — a department A–Z, AI among them, or typed; a role; the file; three steps', () => {
  assert.deepEqual(
    [items.words, items.runWords],
    [
      { singular: 'Job', plural: 'Jobs' },
      { singular: 'Candidate', plural: 'Candidates' },
    ],
  );
  assert.deepEqual([items.titleField, items.groupField], ['role', 'department']);
  const [department, role] = items.fields as [Entry, Entry];
  const options = department.options as unknown as string[];
  assert.deepEqual(options, [
    'Accounting',
    'Administration',
    'AI',
    'Compliance',
    'Customer Support',
    'Data',
    'Engineering',
    'Finance',
    'HR',
    'IT',
    'Legal',
    'Marketing',
    'Operations',
    'Procurement',
    'Product',
    'Research',
    'Sales',
  ]);
  // A–Z as a person reads it, case aside: "AI" after "Administration", never first.
  assert.deepEqual(
    options,
    [...options].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
  );
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
  assert.deepEqual(items.verdictWords, { positive: 'Advance', negative: 'Decline' });
  assert.deepEqual(
    items.pipeline.map((step) => [step.id, step.title, step.description]),
    [
      ['job-received', 'Job description received', 'A PDF, Word file or photo arrives.'],
      ['read-job', 'Job read', "AI reads the role's requirements."],
      ['save-job', 'Job saved', 'Ready for candidates.'],
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

test('the image serves v2 alone: of v1 and v2 it keeps v2, and refuses a run pinned to v1 before any step or call', async () => {
  const all = readManifests(manifestsRoot, TEMPLATE_ID);
  assert.deepEqual(
    all.map((each) => each.version),
    [1, 2],
  );
  const automation = define(all, () => NOW);
  assert.deepEqual(automation.versions, SERVED_VERSIONS);
  const v1 = all.filter((each) => each.version === 1);
  assert.throws(() => define(v1), /serves v2, and no such manifest was given/u);

  const platform = new RecordingPlatform();
  const result = await automation.execute({ ...candidateRun(), templateVersion: 1 }, platform);
  assert.equal(result.outcome, 'failed', JSON.stringify(result));
  assert.deepEqual([platform.steps, platform.artifactReads, platform.modelCalls], [[], [], []]);
});

test('§1: its own container and service account, as v7 of Invoice Processing set them', () => {
  assert.deepEqual(m.service, {
    origin: 'http://candidate-reviewer-v2.autom8x.internal:8080',
    serviceAccount: 'candidate-reviewer-v2@autom8x.iam.gserviceaccount.com',
    contractVersion: 1,
    maxConcurrentRuns: 1,
    acceptTimeoutMs: 5000,
    runTimeoutSeconds: 900,
  });
});

/** A candidate's links in an output schema: their description and their address's. */
function linksOf(schema: unknown) {
  const resume = (schema as { properties: { resume: { properties: Entry } } }).properties.resume;
  return resume.properties.links as { description: string; items: { properties: { url: Entry } } };
}

test("v2 is v1 but for its name, departments, verdict words, container and links' words; the job's reading v1's", () => {
  const v1 = JSON.parse(
    readFileSync(join(manifestsRoot, `${TEMPLATE_ID}.v1.json`), 'utf8'),
  ) as typeof manifest;
  const v1Items = v1.items as unknown as Entry & { fields: Entry[] };
  // v1 is registered and immutable: as it was built.
  assert.deepEqual(
    [v1.version, (v1.display as Entry).name, (v1.service as Entry).origin, v1Items.verdictWords],
    [1, 'Candidate Reviewer', 'http://candidate-reviewer-v1.autom8x.internal:8080', undefined],
  );
  assert.equal((v1Items.fields[0]!.options as unknown as string[]).length, 16);
  // So a job made on v1 serves v2's runs, and v2's candidates are kept as v1's were: v2's output
  // differs from v1's in its two descriptions of a resume's links alone (the spec's F8 note).
  assert.deepEqual(manifest.items.outputSchema, v1.items.outputSchema);
  const links = linksOf(manifest.outputSchema);
  assert.deepEqual(
    [links.description, links.items.properties.url.description],
    [
      'Each web address printed, and each the file links to behind a word: a profile, a portfolio, a site.',
      'The address, as printed or as the file links to it.',
    ],
  );
  const asV1 = structuredClone(manifest.outputSchema);
  const v1Links = linksOf(v1.outputSchema);
  Object.assign(linksOf(asV1), { description: v1Links.description });
  Object.assign(linksOf(asV1).items.properties.url, v1Links.items.properties.url);
  assert.deepEqual(asV1, v1.outputSchema);
  const rest = (each: typeof manifest) => {
    // The output, held above.
    const {
      version: _v,
      display,
      service,
      items: all,
      outputSchema: _out,
      ...others
    } = each as Entry;
    const { name: _name, ...shown } = display as Entry;
    const { origin: _o, serviceAccount: _s, ...container } = service as Entry;
    const { verdictWords: _w, fields, ...kept } = all as Entry & { fields: [Entry, ...Entry[]] };
    const [first, ...after] = fields;
    const { options: _options, ...department } = first;
    return { others, shown, container, kept, fields: [department, ...after] };
  };
  assert.deepEqual(rest(manifest), rest(v1));
});
