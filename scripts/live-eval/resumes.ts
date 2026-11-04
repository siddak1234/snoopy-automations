// Resume Screening's 25 live-eval samples and their job (the owner's Q4): invented people only —
// every name made up, every address at example.com, every phone in 555-0100 to 555-0199, the range
// kept for fiction — each a Word resume built here with Candidate Reviewer's own test writer
// (`automations/candidate-reviewer/test/fixtures.ts`), so its words are checked (Q1). Byte-stable
// on any machine: each entry is deflate's stored blocks (`storedBlocks`), written by the format
// alone, never by a zlib build, as a recording names its file's sha256. Not ZIP's stored method
// (0): Candidate Reviewer's reader refuses an entry not deflated
// (`automations/candidate-reviewer/src/docx.ts`, "not-deflate").
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

/** The most bytes one stored block holds (RFC 1951, section 3.2.4: its length is 16 bits). */
const BLOCK = 0xffff;

/**
 * `data` as deflate's stored blocks: each a header byte (the last block's 1, others' 0), its length
 * and the length's complement, then its bytes as they are. Any inflater reads it, and no
 * compressor writes it, so the bytes are the same on every Node.
 */
export function storedBlocks(data: Uint8Array): Uint8Array {
  const parts: Buffer[] = [];
  for (let at = 0; at === 0 || at < data.byteLength; at += BLOCK) {
    const block = data.subarray(at, at + BLOCK);
    const head = Buffer.alloc(5);
    head.writeUInt8(at + BLOCK >= data.byteLength ? 1 : 0, 0);
    head.writeUInt16LE(block.byteLength, 1);
    head.writeUInt16LE(~block.byteLength & 0xffff, 3);
    parts.push(head, Buffer.from(block));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** A Word file of these paragraphs, its entries deflate's stored blocks. */
const wordFile = (body: string): Uint8Array => docx(body, {}, storedBlocks);

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
  return { filename: `${candidate.sample}.docx`, contentType: WORD_TYPE, bytes: wordFile(body) };
}

/** The job every candidate is scored against: an invented posting, and the item's fields. */
export const JOB = {
  fields: { department: 'Finance', role: 'Senior Accountant' },
  file: (): EvalFile => ({
    filename: 'senior-accountant.docx',
    contentType: WORD_TYPE,
    bytes: wordFile(
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
