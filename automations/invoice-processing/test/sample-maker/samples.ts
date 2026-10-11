import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { JsonObject } from '@autom8x/automation-sdk';

import type { Sample } from './catalog.js';
import { handwrittenPng, phonePhotoJpeg, scannedImagePdf, screenshotPng } from './image-samples.js';
import { longInvoicePdf, missingPagePdf, twoInvoicesPdf } from './paged-samples.js';
import { cardSlipJpeg, longThermalJpeg, storeReceiptJpeg } from './photo-receipt-samples.js';
import { pngScanlines } from './png.js';
import {
  cardRefundPdf,
  cashBackReceipt,
  creditMemoPdf,
  paidInvoicePdf,
} from './receipt-samples.js';
import {
  cardSlipTipOnlyPng,
  handwrittenCashPng,
  restaurantTipUnderTotalPng,
  restaurantWrittenTotalPng,
} from './slip-samples.js';
import {
  bankStatementPdf,
  supplierStatementPdf,
  utilityAccountPng,
  utilityStatementPdf,
} from './statement-samples.js';
import { injectedPdf, receiptPdf, typedTextPdf } from './text-samples.js';

/**
 * The made-up sample documents, committed under `test/samples/<name>/` beside their
 * `expected.json`, and made again from this code by `scripts/make-samples.ts`: the ten of
 * Group 2, then the owner's plan of 2026-10-11's new ones, in §4's order.
 */

export const SAMPLES_DIRECTORY = resolve(import.meta.dirname, '..', 'samples');

export const SAMPLES: readonly Sample[] = [
  typedTextPdf,
  scannedImagePdf,
  phonePhotoJpeg,
  screenshotPng,
  handwrittenPng,
  longInvoicePdf,
  receiptPdf,
  twoInvoicesPdf,
  missingPagePdf,
  injectedPdf,
  storeReceiptJpeg,
  restaurantWrittenTotalPng,
  restaurantTipUnderTotalPng,
  cardSlipTipOnlyPng,
  cardSlipJpeg,
  handwrittenCashPng,
  longThermalJpeg,
  cashBackReceipt,
  paidInvoicePdf,
  creditMemoPdf,
  cardRefundPdf,
  utilityStatementPdf,
  utilityAccountPng,
  supplierStatementPdf,
  bankStatementPdf,
];

export function samplePath(sample: Sample): string {
  return join(SAMPLES_DIRECTORY, sample.name, sample.file);
}

export function expectedPath(sample: Sample): string {
  return join(SAMPLES_DIRECTORY, sample.name, 'expected.json');
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The sample's `expected.json`: what it is, how it was made, and the answer a careful reader gives. */
export function expectedOf(sample: Sample): JsonObject {
  return {
    sample: sample.name,
    file: sample.file,
    contentType: sample.contentType,
    marker: sample.marker,
    markerIn: sample.markerIn,
    made: sample.made,
    decisive: [...sample.decisive],
    extract: 'ok: passed on whole in state.extraction',
    next: sample.next,
    answer: sample.answer,
  };
}

/**
 * Whether the committed file is what the code makes now: the same bytes, or for a PNG the same
 * header and pixels, since zlib's bytes may differ between Node releases.
 */
export function sameAsCommitted(sample: Sample, made: Uint8Array): boolean {
  const path = samplePath(sample);
  if (!existsSync(path)) return false;
  const committed = readFileSync(path);
  if (sample.contentType !== 'image/png') return committed.equals(made);
  const [was, now] = [pngScanlines(committed), pngScanlines(made)];
  return was.header.equals(now.header) && was.rows.equals(now.rows);
}
