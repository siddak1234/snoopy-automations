// What `npm run live-eval` runs for each flow (the owner's Q4): its 25 invented samples, the version
// it expects, the file field a run carries, the key fields it compares — Invoice Processing's
// supplier, number and total of each document, Resume Screening's name, email and phone — read from
// a live run's page, and where its recordings are kept. Nothing here calls the network.
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { partAnswerOf } from '../../automations/invoice-processing/src/run/answer.js';
import { documentReadOf } from '../../automations/invoice-processing/src/run/document-read.js';
import { recordingOf } from '../../automations/invoice-processing/test/recordings.js';
import {
  SAMPLES,
  samplePath,
} from '../../automations/invoice-processing/test/sample-maker/samples.js';
import { EvalError, type EvalFile, type RunDetail } from './client.js';
import { CANDIDATES, JOB, resumeFile, sha256 } from './resumes.js';

/** Key fields by name — "document 1 supplier", "email" — each a value, or null when none. */
export type Fields = Record<string, string | null>;

/** One sample: its name, its file, and the fields its recording gives when no live one was made. */
export interface EvalSample {
  readonly name: string;
  readonly file: () => EvalFile;
  /** The key fields an earlier recording gives, other than the eval's own; undefined when none. */
  readonly recorded?: () => Fields | undefined;
}

export interface Profile {
  readonly templateId: string;
  /** The version the eval expects the subscription to pin. */
  readonly version: number;
  /** The run input's file field. */
  readonly fileKey: string;
  readonly samples: () => readonly EvalSample[];
  /** A flow with items: the job its runs belong to, made first. */
  readonly job?: { readonly fields: Record<string, string>; readonly file: () => EvalFile };
  /** Why the subscription's setup is not one the eval may run; undefined when it may. */
  readonly unsafe: (config: Record<string, unknown>) => string | undefined;
  readonly fieldsOf: (detail: RunDetail) => Fields;
  /** Where the eval's own recordings are kept, one `<sample>.json` each. */
  readonly recordings: string;
}

const ROOT = resolve(import.meta.dirname, '..', '..');
const flow = (id: string) => join(ROOT, 'automations', id);

/** A document's key fields under its place: its supplier, its number, its total. */
function documentFields(
  documents: readonly {
    vendor?: { name?: string | null };
    number?: string | null;
    total?: string | null;
  }[],
): Fields {
  const fields: Fields = { documents: String(documents.length) };
  documents.forEach((document, at) => {
    fields[`document ${at + 1} supplier`] = document.vendor?.name ?? null;
    fields[`document ${at + 1} number`] = document.number ?? null;
    fields[`document ${at + 1} total`] = document.total ?? null;
  });
  return fields;
}

/**
 * Invoice Processing: its 25 made-up samples (`test/samples/`), each run on "None" only — the eval
 * never writes to QuickBooks — and compared, until the eval records its own, with the first read
 * the agents recorded for it (`test/recordings/extract-documents.v1/`), read as the run reads it.
 */
const INVOICE: Profile = {
  templateId: 'invoice-processing',
  version: 8,
  fileKey: 'invoiceFile',
  samples: () =>
    SAMPLES.map((sample) => ({
      name: sample.name,
      // Named by its sample, so each of the 25 is its own: several hold an "invoice.pdf".
      file: () => ({
        filename: `${sample.name}${extname(sample.file)}`,
        contentType: sample.contentType,
        bytes: new Uint8Array(readFileSync(samplePath(sample))),
      }),
      recorded: () => {
        const recording = recordingOf(sample);
        if (recording === undefined) return undefined;
        const part = partAnswerOf(JSON.parse(recording.text));
        return part === undefined ? undefined : documentFields(part.documents.map(documentReadOf));
      },
    })),
  unsafe: (config) =>
    (config.vendor ?? 'none') === 'none'
      ? undefined
      : 'the eval runs Invoice Processing on "None" only, so it never writes to QuickBooks',
  fieldsOf: (detail) => documentFields(detail.documents ?? []),
  recordings: join(flow('invoice-processing'), 'test', 'live-eval'),
};

/** A Contact row's value by what it is ("Email", "Phone"); null when the resume has none. */
function contact(detail: RunDetail, subtitle: string): string | null {
  const rows = detail.sections?.find((section) => section.title === 'Contact')?.entries ?? [];
  return rows.find((row) => row.subtitle === subtitle)?.title ?? null;
}

/** Resume Screening: 25 invented Word resumes, scored against one invented job made first. */
const RESUMES: Profile = {
  templateId: 'candidate-reviewer',
  version: 3,
  fileKey: 'resumeFile',
  samples: () =>
    CANDIDATES.map((candidate) => ({ name: candidate.sample, file: () => resumeFile(candidate) })),
  job: JOB,
  unsafe: () => undefined,
  fieldsOf: (detail) => ({
    name: detail.run.title ?? null,
    email: contact(detail, 'Email'),
    phone: contact(detail, 'Phone'),
  }),
  recordings: join(flow('candidate-reviewer'), 'test', 'live-eval'),
};

export const PROFILES: Readonly<Record<string, Profile>> = {
  [INVOICE.templateId]: INVOICE,
  [RESUMES.templateId]: RESUMES,
};

/** One sample's recording as the eval keeps it. */
export interface Recording {
  readonly sample: string;
  readonly fileSha256: string;
  readonly templateVersion: number;
  readonly recordedAt: string;
  readonly fields: Fields;
}

export const recordingPath = (profile: Profile, sample: string): string =>
  join(profile.recordings, `${sample}.json`);

/**
 * The fields a sample is compared with: the eval's own recording when there is one — refused when
 * it was made for other bytes — else the flow's earlier one; undefined when neither exists.
 */
export function baselineOf(
  profile: Profile,
  sample: EvalSample,
  bytes: Uint8Array,
): { fields: Fields; from: string } | undefined {
  const path = recordingPath(profile, sample.name);
  if (existsSync(path)) {
    const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;
    if (recording.fileSha256 !== sha256(bytes)) {
      throw new EvalError(
        `${sample.name}: its recording was made for another file: record it again`,
      );
    }
    return { fields: recording.fields, from: 'recorded live' };
  }
  const fields = sample.recorded?.();
  return fields === undefined ? undefined : { fields, from: "the agents' first read" };
}
