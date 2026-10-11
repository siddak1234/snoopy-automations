import { encodeJpeg } from './jpeg.js';
import type { Line } from './layout.js';
import { writePdf, type PdfPage } from './pdf.js';
import type { Canvas, TextStyle } from './raster.js';

/**
 * The layouts drawn: as Courier text on PDF pages, or in the bitmap font on a canvas — and a
 * canvas as a scanned PDF page.
 */

export interface PageSize {
  /** Points. */
  readonly width: number;
  readonly height: number;
  /** Courier's size and the distance between baselines, in points. */
  readonly size: number;
  readonly leading: number;
  /** The first baseline's distance from the top, and the left margin, in points. */
  readonly top: number;
  readonly left: number;
}

/** US Letter: 78 columns of 10-point Courier, 13 points apart. */
export const LETTER: PageSize = {
  width: 612,
  height: 792,
  size: 10,
  leading: 13,
  top: 60,
  left: 72,
};

/** One page of `lines`: a blank line keeps its place and draws nothing. */
export function textPage(lines: readonly Line[], size: PageSize = LETTER): PdfPage {
  return {
    width: size.width,
    height: size.height,
    lines: lines.flatMap((line, index) =>
      line.text.trim() === ''
        ? []
        : [
            {
              x: size.left,
              y: size.height - size.top - index * size.leading,
              size: size.size,
              text: line.text,
              ...(line.bold ? { bold: true } : {}),
            },
          ],
    ),
  };
}

/** The pages as a text PDF. */
export function textPdf(pages: readonly (readonly Line[])[], size: PageSize = LETTER): Uint8Array {
  return writePdf(pages.map((lines) => textPage(lines, size)));
}

/** `lines` on `canvas`, `lineHeight` pixels apart from (x, y), in `style`. */
export function drawLines(
  canvas: Canvas,
  lines: readonly Line[],
  x: number,
  y: number,
  lineHeight: number,
  style: TextStyle = {},
): void {
  lines.forEach((line, index) => {
    if (line.text.trim() === '') return;
    canvas.text(x, y + index * lineHeight, line.text, {
      ...style,
      ...(line.bold ? { bold: true } : {}),
    });
  });
}

/** A grayscale canvas as one PDF page holding a JPEG of `quality` — a scanner's PDF. */
export function scannedPdf(canvas: Canvas, quality: number, size: PageSize = LETTER): Uint8Array {
  return writePdf([
    {
      width: size.width,
      height: size.height,
      image: {
        jpeg: encodeJpeg(canvas.width, canvas.height, canvas.data, 1, quality),
        width: canvas.width,
        height: canvas.height,
        components: 1,
      },
    },
  ]);
}
