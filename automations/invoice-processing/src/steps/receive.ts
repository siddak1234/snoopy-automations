import { CallbackRefusedError, type ArtifactReference, type Step } from '@autom8x/automation-sdk';

import { DECLARED_KINDS, FILE_LIMITS, measurementsOf, type FileMeasurements } from '../file.js';
import { failedWith, grouped } from '../outcome.js';
import type { FileState } from '../state.js';

/**
 * `receive` — check the invoice file, before anything is spent.
 *
 * The run's input names the upload; the artifact callback answers with its reference
 * and the platform's measurements, which are held to `FILE_LIMITS`: the declared type
 * one of the three, the measured kind the same, then the size, the pages or the pixels.
 * The file is never downloaded here: the platform measured it once at upload, and sends
 * it to the model itself. A 404 is a file this run was not given, or one that is gone; any other
 * failure is thrown unchanged, so the SDK's retry repeats a transient one and the run's
 * wrapper gives its sentence when the attempts are spent.
 */

export const RECEIVE_SENTENCES = {
  no_file: 'No invoice file was given. Start the run again with the invoice.',
  file_gone: 'The invoice file is no longer available. Upload it again and start a new run.',
  file_unchecked: 'This file could not be checked; upload it again.',
  unsupported_type:
    'The invoice must be a PDF, JPEG or PNG file. Upload it in one of those formats and start a new run.',
  content_mismatch:
    'This file is not a real PDF, JPEG or PNG. Save the invoice again as a PDF, or take a photo of it.',
  file_too_large:
    'The invoice file is larger than 3.5 MB. Upload a smaller file or a photo of the invoice.',
  too_many_pages: 'This PDF has more than 10 pages. Upload only the invoice pages, at most 10.',
  image_too_large:
    'This image is more than 8,000 pixels on a side. Upload a smaller photo or the PDF.',
} as const;

type Refusal = keyof typeof RECEIVE_SENTENCES;

function refused(reason: Refusal) {
  return failedWith('Invoice file not accepted', reason, RECEIVE_SENTENCES[reason]);
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

/** The timeline line: the kind, the pages or the pixels, the bytes — never the filename or the link. */
function received(measured: Exclude<FileMeasurements, { kind: 'other' }>): string {
  const bytes = `${grouped(measured.sizeBytes)} bytes`;
  if (measured.kind === 'pdf') return `Received a ${measured.pageCount}-page PDF, ${bytes}`;
  const what = measured.kind === 'jpeg' ? 'a JPEG photo' : 'a PNG image';
  const size = `${grouped(measured.widthPixels)} x ${grouped(measured.heightPixels)} px`;
  return `Received ${what}, ${size}, ${bytes}`;
}
