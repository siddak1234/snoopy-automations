// Resume Screening's 25 live-eval samples and their job (the owner's Q4): invented people only —
// every name made up, every address at example.com, every phone in 555-0100 to 555-0199, the range
// kept for fiction — each a Word resume built here, byte-stable, with Candidate Reviewer's own test
// writer (`automations/candidate-reviewer/test/fixtures.ts`), so its words are checked (Q1).
import { createHash } from 'node:crypto';

import { WORD_TYPE } from '../../automations/candidate-reviewer/src/file.js';
import { docx, paragraph } from '../../automations/candidate-reviewer/test/fixtures.js';
import type { EvalFile } from './client.js';

/** One invented candidate: what the resume prints. */
export interface Candidate {
  readonly sample: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly title: string;
  readonly company: string;
  readonly since: number;
}

const FIRST = [
  'Avery',
  'Bram',
  'Cleo',
  'Dorian',
  'Esme',
  'Felix',
  'Greta',
  'Hollis',
  'Ines',
  'Jasper',
];
const LAST = ['Quillfeather', 'Marrowby', 'Thistlewood', 'Fernhallow', 'Brightwater'];
const ROLES: readonly (readonly [title: string, company: string])[] = [
  ['Senior Accountant', 'Harrowgate Office Supply'],
  ['Staff Accountant', 'Kestrel Courier Co'],
  ['Accounting Manager', 'Bluefinch Print Shop'],
  ['Controller', 'Pinecrest Janitorial'],
  ['Accounts Payable Lead', 'Copperleaf Catering'],
];

/** The 25, each its own made-up name, address and phone; some with no phone, as resumes go. */
export const CANDIDATES: readonly Candidate[] = Array.from({ length: 25 }, (_, at) => {
  const first = FIRST[at % FIRST.length]!;
  const last = LAST[Math.floor(at / FIRST.length) % LAST.length]!;
  const [title, company] = ROLES[at % ROLES.length]!;
  return {
    sample: `candidate-${String(at + 1).padStart(2, '0')}`,
    name: `${first} ${last}`,
    email: `${first}.${last}@example.com`.toLowerCase(),
    phone: at % 6 === 5 ? '' : `+1 555 01${String(at + 10).padStart(2, '0')}`,
    title,
    company,
    since: 2014 + (at % 9),
  };
});

/** A candidate's resume as a Word file: the name, the contact line, then one role. */
export function resumeFile(candidate: Candidate): EvalFile {
  const contact = [candidate.email, candidate.phone].filter((part) => part !== '').join(' | ');
  const body = [
    paragraph(candidate.name),
    paragraph(contact),
    paragraph('Experience'),
    paragraph(`${candidate.title}, ${candidate.company}, ${candidate.since} to present`),
    paragraph('Led the month-end close and the reconciliations.'),
    paragraph('Education'),
    paragraph('B.S. Accounting, State University'),
    paragraph('Skills: Excel, NetSuite, reconciliations'),
  ].join('');
  return { filename: `${candidate.sample}.docx`, contentType: WORD_TYPE, bytes: docx(body) };
}

/** The job every candidate is scored against: an invented posting, and the item's fields. */
export const JOB = {
  fields: { department: 'Finance', role: 'Senior Accountant' },
  file: (): EvalFile => ({
    filename: 'senior-accountant.docx',
    contentType: WORD_TYPE,
    bytes: docx(
      [
        paragraph('Senior Accountant'),
        paragraph('Finance, full-time, hybrid'),
        paragraph(
          'Must have: a CPA license; 5 or more years of accounting; month-end close ownership.',
        ),
        paragraph('Nice to have: NetSuite; audit experience.'),
        paragraph('You will run the month-end close and prepare reconciliations.'),
      ].join(''),
    ),
  }),
} as const;

/** A file's sha256, which a recording names: one made for other bytes is made again. */
export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
