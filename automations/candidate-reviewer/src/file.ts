import { truncateText, type JsonObject, type StepPlatform } from '@autom8x/automation-sdk';

import { docxText } from './docx.js';

/**
 * The files Candidate Reviewer takes — a job description and a resume alike (the spec's §2): a
 * PDF, a JPEG or a PNG, which the model reads as the file, or a Word file (.docx), whose text is
 * read here and sent as the prompt's input. All four are the manifest's `artifacts` block, and
 * `automations/candidate-reviewer/test/manifest.test.ts` holds them equal; no page or pixel limit
 * is declared, because Word is not a type the platform measures (its rule: measured types only).
 */
export const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MODEL_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const FILE_LIMITS = {
  acceptedContentTypes: [...MODEL_TYPES, WORD_TYPE],
  maximumSizeBytes: 3_500_000,
} as const;

/** The most of a Word file's text the model is sent, in characters: far past any resume. */
export const MAXIMUM_TEXT_LENGTH = 50_000;

/** What the model reads: the run's file by its id, or a Word file's text. */
export type FileRead = { kind: 'file'; artifactId: string } | { kind: 'text'; text: string };

/** The type the upload declared, without its parameters, in lower case. */
const typeOf = (contentType: string) => contentType.split(';')[0]!.trim().toLowerCase();

/**
 * The run's file, as the model will read it — or `undefined` when it cannot be read: a type
 * this flow does not take, or a Word file whose text will not come out (`docx.ts`) or holds none.
 * The upload's id is the platform's; the bytes are read only for a Word file. The platform
 * checks a PDF's or a photo's own bytes against its declared type when the model is sent it.
 */
export async function readFile(
  platform: StepPlatform,
  artifactId: string,
): Promise<FileRead | undefined> {
  const reference = await platform.readArtifact(artifactId);
  const type = typeOf(reference.contentType);
  if ((MODEL_TYPES as readonly string[]).includes(type)) return { kind: 'file', artifactId };
  if (type !== WORD_TYPE) return undefined;
  const read = docxText(await platform.readArtifactBytes(reference));
  if (!read.ok || read.text === '') return undefined;
  return { kind: 'text', text: truncateText(read.text, MAXIMUM_TEXT_LENGTH) };
}

/** The upload's id the run's input carries under `key`, or `undefined`. */
export function fileIdOf(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** How a step's line names the file: its kind, never its name, which may carry a person's. */
export function fileLine(read: FileRead): string {
  return read.kind === 'file'
    ? 'a PDF or photo the model reads'
    : `a Word file, ${read.text.length.toLocaleString('en-US')} characters of text`;
}

/** The file as a step keeps it in the run's state, and reads it back. */
export const fileState = (read: FileRead): JsonObject => ({ ...read });

export function fileFromState(value: unknown): FileRead | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const read = value as Record<string, unknown>;
  if (read.kind === 'file' && typeof read.artifactId === 'string') {
    return { kind: 'file', artifactId: read.artifactId };
  }
  if (read.kind === 'text' && typeof read.text === 'string') {
    return { kind: 'text', text: read.text };
  }
  return undefined;
}
