import type { ArtifactReference } from '@autom8x/automation-sdk';

import { jpeg, pdf, png } from './fixtures.js';

/**
 * A sample measured as the platform measures an upload when it is sealed — its real kind from
 * the leading bytes, a PDF's pages, an image's stored sides — enough for these samples, which
 * this repository wrote, and handed to `receive` as the artifact callback would.
 */
export interface Measured {
  readonly kind: 'pdf' | 'jpeg' | 'png' | 'other';
  readonly sizeBytes: number;
  readonly pages: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export function measure(file: Uint8Array): Measured {
  const bytes = Buffer.from(file);
  const sizeBytes = bytes.length;
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    const count = /\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/u.exec(bytes.toString('latin1'));
    return {
      kind: 'pdf',
      sizeBytes,
      pages: count ? Number(count[1]) : null,
      width: null,
      height: null,
    };
  }
  if (bytes.readUInt32BE(0) === 0x89504e47) {
    return {
      kind: 'png',
      sizeBytes,
      pages: null,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      const marker = bytes[at + 1] ?? 0;
      if (marker === 0xc0) {
        return {
          kind: 'jpeg',
          sizeBytes,
          pages: null,
          width: bytes.readUInt16BE(at + 7),
          height: bytes.readUInt16BE(at + 5),
        };
      }
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return { kind: 'other', sizeBytes, pages: null, width: null, height: null };
}

/** The reference the artifact callback answers for the sample, with the platform's measurements. */
export function referenceOf(measured: Measured): ArtifactReference {
  const { kind, sizeBytes } = measured;
  if (kind === 'pdf') return pdf({ sizeBytes, pageCount: measured.pages });
  const sides = { sizeBytes, widthPixels: measured.width, heightPixels: measured.height };
  return kind === 'jpeg' ? jpeg(sides) : png(sides);
}
