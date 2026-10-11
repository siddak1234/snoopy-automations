/**
 * A PDF writer for the samples: pages of Courier text and pages holding one JPEG, with no
 * compression, no dates and no ids, so the bytes are the same on every machine and every word
 * a text page prints can be found in the file.
 */

/** One line of text, its baseline `y` points from the bottom of the page. */
export interface PdfLine {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly bold?: boolean;
  readonly text: string;
}

export interface PdfPage {
  /** In points, 72 to the inch. */
  readonly width: number;
  readonly height: number;
  readonly lines?: readonly PdfLine[];
  /** A JPEG drawn over the whole page, as a scanner writes one. */
  readonly image?: {
    readonly jpeg: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly components: 1 | 3;
  };
}

/** Text as a PDF string: printable ASCII, its three special characters escaped. */
function literal(text: string): string {
  if (!/^[ -~]*$/u.test(text)) throw new Error(`not printable ASCII: ${JSON.stringify(text)}`);
  return `(${text.replace(/[\\()]/gu, (character) => `\\${character}`)})`;
}

function contents(page: PdfPage): string {
  const drawn: string[] = [];
  if (page.image) drawn.push(`q ${page.width} 0 0 ${page.height} 0 0 cm /Im1 Do Q`);
  for (const line of page.lines ?? []) {
    drawn.push(
      `BT /${line.bold ? 'F2' : 'F1'} ${line.size} Tf ${line.x} ${line.y} Td ${literal(line.text)} Tj ET`,
    );
  }
  return `${drawn.join('\n')}\n`;
}

/** The pages as one PDF 1.4 file. */
export function writePdf(pages: readonly PdfPage[]): Uint8Array {
  const objects: (string | Uint8Array)[][] = [];
  const add = (...parts: (string | Uint8Array)[]): number => objects.push(parts);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, written once the pages have numbers
  const fonts = [
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'),
  ];
  const kids = pages.map((page) => {
    const stream = contents(page);
    const content = add(`<< /Length ${stream.length} >>\nstream\n`, stream, 'endstream');
    let xobject = '';
    if (page.image) {
      const { jpeg, width, height, components } = page.image;
      const space = components === 1 ? '/DeviceGray' : '/DeviceRGB';
      const image = add(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        jpeg,
        '\nendstream',
      );
      xobject = ` /XObject << /Im1 ${image} 0 R >>`;
    }
    return add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R >>${xobject} >> /Contents ${content} 0 R >>`,
    );
  });
  objects[1] = [
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];

  const chunks: Uint8Array[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const offsets = objects.map((parts, index) => {
    const offset = length;
    write(`${index + 1} 0 obj\n`);
    for (const part of parts) write(part);
    write('\nendobj\n');
    return offset;
  });
  const xref = length;
  write(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) write(`${String(offset).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
