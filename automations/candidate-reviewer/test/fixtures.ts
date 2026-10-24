import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { readManifests, type JsonObject, type ModelRequest } from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  artifactFixture,
  invokeFixture,
  itemFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';
import { WORD_TYPE } from '../src/file.js';

/**
 * The suite's made-up world (the spec's §9: made-up inputs only): the manifest, a fixed day, a
 * recording platform whose model answers by prompt, the files a run is given, and Word files built
 * here in memory. No name, address or posting below is a real one.
 */

export const manifestsRoot = resolve(import.meta.dirname, '..', '..', '..', 'manifests');
export const manifestPath = join(manifestsRoot, `${TEMPLATE_ID}.v1.json`);
export const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as JsonObject & {
  items: JsonObject & { outputSchema: JsonObject };
  outputSchema: JsonObject;
};

/** The day the suite runs on: a current role's years run to it. */
export const NOW = new Date('2026-10-24T12:00:00Z');

export const FILE_ID = '33333333-3333-4333-8333-333333333333';

/** The job's reading a candidate is scored against: three must-haves, two nice-to-haves. */
export const READING: JsonObject = {
  title: 'Senior Accountant',
  department: 'Finance',
  location: 'Austin, TX (hybrid)',
  employmentType: 'Full-time',
  summary: 'Owns the month-end close for a mid-size distributor.',
  mustHaves: ['CPA license', '5+ years of accounting experience', 'Month-end close ownership'],
  niceToHaves: ['NetSuite', 'Audit experience'],
  responsibilities: ['Run the month-end close', 'Prepare reconciliations'],
  minimumYears: 5,
  education: "Bachelor's degree in accounting",
  certifications: ['CPA'],
  skills: ['Excel', 'NetSuite'],
  pay: '$85,000–$100,000 a year',
  uncertainFields: [],
};

/** `extract-posting`'s answer for a job description: readable, with `READING`'s words. */
export const postingAnswer = (overrides: JsonObject = {}): JsonObject => ({
  readable: true,
  ...READING,
  ...overrides,
});

const EMPTY_RESUME = {
  name: '',
  email: '',
  phone: '',
  location: '',
  links: [],
  summary: '',
  experience: [],
  education: [],
  projects: [],
  certifications: [],
  skills: [],
  languages: [],
  uncertainFields: [],
  directions: [],
};

/** `extract-resume`'s answer for a resume: Jane Doe, made up, with three links. */
export const resumeAnswer = (overrides: JsonObject = {}): JsonObject => ({
  ...EMPTY_RESUME,
  document: 'resume',
  name: 'Jane Doe',
  email: 'jane.doe@example.com',
  phone: '+1 555 0100',
  location: 'Austin, TX',
  links: [
    { url: 'https://linkedin.example.com/in/jane-doe', label: 'LinkedIn' },
    { url: 'janedoe.example.com', label: 'Portfolio' },
    { url: 'https://code.example.org/jane-doe', label: '' },
  ],
  summary: 'CPA with eight years in distribution accounting.',
  experience: [
    {
      title: 'Senior Accountant',
      company: 'Acme Corp',
      start: '2021-03',
      end: '',
      current: true,
      highlights: ['Led month-end close', 'Cut the close to 4 days'],
    },
    {
      title: 'Staff Accountant',
      company: 'Birch Supply',
      start: '2018',
      end: '2021',
      current: false,
      highlights: [],
    },
  ],
  education: [{ degree: 'B.S.', field: 'Accounting', school: 'State University', year: '2018' }],
  projects: [
    {
      name: 'Close checklist',
      description: 'A shared checklist for the close.',
      url: 'https://code.example.org/jane-doe/close-checklist',
    },
  ],
  certifications: [{ name: 'CPA', issuer: 'Texas State Board', year: '2020' }],
  skills: ['Reconciliations', 'Excel', 'NetSuite'],
  languages: ['English', 'Spanish (conversational)'],
  ...overrides,
});

/** A file that is not a resume, as the model reads it. */
export const receiptAnswer = (): JsonObject => ({ ...EMPTY_RESUME, document: 'not_a_resume' });
/** A blank page, as the model reads it. */
export const blankAnswer = (): JsonObject => ({ ...EMPTY_RESUME, document: 'unreadable' });

/** `score-candidate`'s answer: every must-have met, or the ones `missing` names not. */
export function scoreAnswer(score: number, missing: readonly string[] = []): JsonObject {
  const musts = READING.mustHaves as string[];
  return {
    score,
    summary: 'Meets the must-haves named, with close ownership at Acme Corp.',
    matches: [
      ...musts
        .filter((requirement) => !missing.includes(requirement))
        .map((requirement) => ({
          requirement,
          kind: 'must_have',
          evidence: 'Shown on the resume.',
        })),
      { requirement: 'NetSuite', kind: 'nice_to_have', evidence: 'Listed under skills.' },
    ],
    gaps: [
      ...missing.map((requirement) => ({ requirement, kind: 'must_have' })),
      { requirement: 'Audit experience', kind: 'nice_to_have' },
    ],
    experienceFit: 'Meets the years asked for.',
    educationFit: 'Holds the degree asked for.',
    certificationsFit: 'Holds the CPA.',
    flags: [],
  };
}

/** Which prompt a call sends, by its schema: each prompt's has a field the others lack. */
export function promptOf(call: ModelRequest): 'posting' | 'resume' | 'score' {
  const properties = (call.outputSchema.properties ?? {}) as JsonObject;
  if ('readable' in properties) return 'posting';
  if ('document' in properties) return 'resume';
  return 'score';
}

/** The answers the model gives, by prompt. */
export interface Answers {
  posting?: JsonObject;
  resume?: JsonObject;
  score?: JsonObject;
}

/** The automation on the fixed day, a platform answering as `answers` say, and one file given. */
export function world(answers: Answers, file: { contentType?: string; bytes?: Uint8Array } = {}) {
  const automation = define(readManifests(manifestsRoot, TEMPLATE_ID), () => NOW);
  const platform = new RecordingPlatform();
  platform.artifacts = [
    artifactFixture({
      artifactId: FILE_ID,
      contentType: file.contentType ?? 'application/pdf',
      sizeBytes: file.bytes?.byteLength ?? 184_203,
    }),
  ];
  platform.bytes = () => file.bytes ?? new Uint8Array();
  platform.model = (call, model) => {
    const answer = answers[promptOf(call)];
    if (answer === undefined) throw new Error(`no ${promptOf(call)} answer scripted`);
    return Promise.resolve({
      text: JSON.stringify(answer),
      model,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  return { automation, platform };
}

/** A candidate's run, on a job whose reading is `reading`. */
export const candidateRun = (reading: JsonObject | null = READING) =>
  invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    input: { resumeFile: FILE_ID },
    item: itemFixture({ fields: { department: 'Finance', role: 'Senior Accountant' }, reading }),
  });

/** The item run that makes a job from its job description. */
export const jobRun = () =>
  invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    input: { jobFile: FILE_ID },
    item: itemFixture({ fields: { department: 'Finance', role: 'Senior Accountant' } }),
    readsItem: true,
  });

/** One ZIP entry as `zip` writes it; the fields a test changes to make a bad one. */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  /** The sizes the central directory claims, when a test lies about them. */
  storedSize?: number;
  inflatedSize?: number;
}

/** A ZIP archive built here, by the format's own layout: local entries, the directory, its end. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const stored = Buffer.from(method === 8 ? deflateRawSync(entry.data) : entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.storedSize ?? stored.byteLength, 20);
    central.writeUInt32LE(entry.inflatedSize ?? entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    directory.push(central, name);
    offset += local.byteLength + name.byteLength + stored.byteLength;
  }
  const size = directory.reduce((total, part) => total + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...directory, end]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** `word/document.xml` holding `body`'s WordprocessingML. */
export const documentXml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`;

/** A paragraph of one run of text. */
export const paragraph = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** A page header's or footer's XML holding these paragraphs. */
export const partXml = (part: 'hdr' | 'ftr', body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${part} ${W}>${body}</w:${part}>`;

/** A Word file whose body is these paragraphs, its content types first as Word writes them. */
export function docx(body: string, document: Partial<ZipEntry> = {}): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(body), 'utf8'), ...document },
  ]);
}

export const WORD = { contentType: WORD_TYPE } as const;
