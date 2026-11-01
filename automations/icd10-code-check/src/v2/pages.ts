import { BATCH_LIMITS, type PageRange } from '@autom8x/automation-sdk';

/**
 * Pages (the spec's v2 section, "The batch"): how many a file has, the windows the model reads it
 * in (at most `BATCH_LIMITS.pages` a call, the platform's page range), and a visit's pages as the
 * ranges its unit names.
 */

/** Where a file's page count came from: the platform measured it, or the chunk step counted it. */
export type PagesFrom = 'measured' | 'counted';

/**
 * A PDF's pages counted from its bytes: each page object (`/Type /Page`, never `/Pages`). Used only
 * when the platform did not measure the file (`pageCount` null); a PDF whose page objects are
 * compressed counts 0, and is read whole.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![A-Za-z])/gu) ?? []).length;
}

/** A file's pages in windows of at most `size`, in order: 1–20, 21–40, … */
export function windowsOf(count: number, size: number = BATCH_LIMITS.pages): PageRange[] {
  const out: PageRange[] = [];
  for (let from = 1; from <= count; from += size) {
    out.push({ from, to: Math.min(count, from + size - 1) });
  }
  return out;
}

/** Pages of one file as ranges: each run of consecutive pages, cut at `size` pages. */
export function rangesOf(pages: readonly number[], size: number = BATCH_LIMITS.pages): PageRange[] {
  const out: PageRange[] = [];
  for (const page of pages) {
    const last = out.at(-1);
    if (last !== undefined && page === last.to + 1 && last.to - last.from + 1 < size) {
      last.to = page;
    } else {
      out.push({ from: page, to: page });
    }
  }
  return out;
}
