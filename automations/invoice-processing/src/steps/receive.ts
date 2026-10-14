import { CallbackRefusedError, type ArtifactReference, type Step } from '@autom8x/automation-sdk';

import { DECLARED_KINDS, FILE_LIMITS, measurementsOf, type FileMeasurements } from '../file.js';
import { runFails } from '../outcome.js';
import type { FileState } from '../state.js';

/**
 * `receive` — check the document's file, before anything is spent.
 *
 * The run's input names the upload; the artifact callback answers with its reference
 * and the platform's measurements, which are held to `FILE_LIMITS`: the declared type
 * one of the three, the measured kind the same, then the size, the pages or the pixels.
 * The file is never downloaded here: the platform measured it once at upload, and sends
 * it to the model itself. A 404 is a file this run was not given, or one that is gone; any other
 * failure is thrown unchanged, so the SDK's retry repeats a transient one and the run's
 * wrapper gives its sentence when the attempts are spent.
 */

/**
 * Why a file is refused, each a code for the log. Every one but "no file" ends the run with one
 * plain sentence (§3.F): the platform already holds an upload to the manifest's limits when it is
 * sealed, so a refusal here is a file that could not be opened as it should.
 */
export const RECEIVE_REFUSALS = [
  'no_file',
  'file_gone',
  'file_unchecked',
  'unsupported_type',
  'content_mismatch',
  'file_too_large',
  'too_many_pages',
  'image_too_large',
] as const;

type Refusal = (typeof RECEIVE_REFUSALS)[number];

function refused(reason: Refusal) {
  return runFails(reason === 'no_file' ? 'no_file' : 'file', reason);
}

export const receive: Step = async ({ request, state, platform }) => {
  const id = request.input.invoiceFile;
  if (typeof id !== 'string' || id.trim() === '') return refused('no_file');
  let reference: ArtifactReference;
  try {
    reference = await platform.readArtifact(id.trim());
  } catch (error) {
    if (error instanceof CallbackRefusedError && error.status === 404) return refused('file_gone');
    throw error;
  }
  const measured = measurementsOf(reference);
  if (!measured) return refused('file_unchecked');
  const declared = DECLARED_KINDS.get(reference.contentType.trim().toLowerCase());
  if (!declared || measured.kind === 'other') return refused('unsupported_type');
  // The platform refuses a file whose bytes are not its declared type when the upload is
  // sealed; held here too, because the platform's model call reads it by that type.
  if (measured.kind !== declared) return refused('content_mismatch');
  if (measured.sizeBytes > FILE_LIMITS.maximumSizeBytes) return refused('file_too_large');
  if (measured.kind === 'pdf') {
    if (measured.pageCount > FILE_LIMITS.maximumPdfPages) return refused('too_many_pages');
  } else if (
    measured.widthPixels > FILE_LIMITS.maximumImageSidePixels ||
    measured.heightPixels > FILE_LIMITS.maximumImageSidePixels
  ) {
    return refused('image_too_large');
  }
  const file: FileState = {
    artifactId: reference.artifactId,
    kind: measured.kind,
    sizeBytes: measured.sizeBytes,
    pages: measured.pageCount,
    sha256: typeof reference.sha256 === 'string' ? reference.sha256 : null,
  };
  return { outcome: 'ok', summary: received(measured), state: { ...state, file } };
};

/** The timeline line (§3.E): `PDF, 2 pages` or `Photo` — never the filename or the link. */
function received(measured: Exclude<FileMeasurements, { kind: 'other' }>): string {
  if (measured.kind !== 'pdf') return 'Photo';
  return `PDF, ${measured.pageCount} ${measured.pageCount === 1 ? 'page' : 'pages'}`;
}
