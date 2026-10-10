import type { ArtifactReference } from '@autom8x/automation-sdk';

/**
 * The invoice file: the owner's limits, and the one place the platform's measurements
 * of it are read.
 *
 * The platform measures a file once, when its upload is sealed — its real kind from the
 * leading bytes, a PDF's pages, an image's stored width and height (its BUILD-PLAN
 * 25.2.28) — refuses one over the limits before any run exists, and returns the
 * measurements with the artifact read. `receive` holds them to `FILE_LIMITS`, and never
 * downloads or parses the file itself.
 */

/**
 * The owner's decisions of 2026-10-10: a PDF, JPEG or PNG; at most 3,500,000 bytes; a
 * PDF at most 10 pages; an image at most 8,000 px on a side. The first two are the
 * manifest's `artifacts` block, and a test holds them equal; the last two are named as
 * the platform names the block's page and pixel limits, which the vendored schema
 * gains when its pull request merges.
 */
export const FILE_LIMITS = {
  acceptedContentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  maximumSizeBytes: 3_500_000,
  maximumPdfPages: 10,
  maximumImageSidePixels: 8_000,
} as const;

export type FileKind = 'pdf' | 'jpeg' | 'png';

/** The kind each accepted type declares — `contentType` is the uploader's word for it. */
export const DECLARED_KINDS: ReadonlyMap<string, FileKind> = new Map([
  ['application/pdf', 'pdf'],
  ['image/jpeg', 'jpeg'],
  ['image/png', 'png'],
]);

const KINDS: ReadonlySet<string> = new Set(['pdf', 'jpeg', 'png']);

/** What the platform measured: every field, each null where the kind has none. */
export type FileMeasurements =
  | {
      readonly kind: 'pdf';
      readonly sizeBytes: number;
      readonly pageCount: number;
      readonly widthPixels: null;
      readonly heightPixels: null;
    }
  | {
      readonly kind: 'jpeg' | 'png';
      readonly sizeBytes: number;
      readonly pageCount: null;
      readonly widthPixels: number;
      readonly heightPixels: number;
    }
  | {
      /** A kind this automation does not read. */
      readonly kind: 'other';
      readonly sizeBytes: number;
      readonly pageCount: null;
      readonly widthPixels: null;
      readonly heightPixels: null;
    };

/**
 * THE ADAPTER — the one function that reads the platform's measurement fields
 * (`measuredKind`, `pageCount`, `widthPixels`, `heightPixels`), copied into the SDK's
 * `ArtifactReference` from the platform's pull request before it merged. If the names
 * move, this function and that copy change, and nothing else.
 *
 * `undefined` when a measurement the file's kind needs is null, missing or malformed —
 * the kind, the size, a PDF's page count, an image's width and height — so the run
 * fails closed rather than guess.
 */
export function measurementsOf(reference: ArtifactReference): FileMeasurements | undefined {
  const { measuredKind, sizeBytes } = reference;
  if (typeof measuredKind !== 'string' || !isCount(sizeBytes, 0)) return undefined;
  if (!KINDS.has(measuredKind)) {
    return { kind: 'other', sizeBytes, pageCount: null, widthPixels: null, heightPixels: null };
  }
  if (measuredKind === 'pdf') {
    const { pageCount } = reference;
    return isCount(pageCount, 1)
      ? { kind: 'pdf', sizeBytes, pageCount, widthPixels: null, heightPixels: null }
      : undefined;
  }
  const { widthPixels, heightPixels } = reference;
  return isCount(widthPixels, 1) && isCount(heightPixels, 1)
    ? { kind: measuredKind, sizeBytes, pageCount: null, widthPixels, heightPixels }
    : undefined;
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
