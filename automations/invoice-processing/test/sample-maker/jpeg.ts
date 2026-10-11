/**
 * A baseline JPEG encoder for the image samples — grayscale or YCbCr without subsampling, the
 * standard tables of ITU-T T.81 Annex K — so the samples need no library. Integer arithmetic
 * after two tables are rounded once, so the same pixels give the same bytes on every machine.
 */

/** Annex K.1's luminance and chrominance quantisation tables, in natural order. */
const LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...Array<number>(32).fill(99),
];

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Annex K.3's Huffman tables: code counts by length, then the symbols. */
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: range(12) };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: range(12) };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  values: hex(
    '01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa',
  ),
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  values: hex(
    '000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa',
  ),
};

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function hex(text: string): number[] {
  return Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16),
  );
}

interface Table {
  readonly bits: readonly number[];
  readonly values: readonly number[];
}

/** Each symbol's code and length, built from the table as T.81 Annex C does. */
function codes(table: Table): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let next = 0;
  table.bits.forEach((count, index) => {
    for (let n = 0; n < count; n += 1) out.set(table.values[next++] ?? 0, [code++, index + 1]);
    code <<= 1;
  });
  return out;
}

/**
 * The DCT's basis at [u * 8 + x], scaled by 4,096 and rounded once: cos((2x + 1)uπ / 16), the
 * u = 0 row divided by √2. Everything after it is exact integer arithmetic.
 */
const BASIS = Int32Array.from({ length: 64 }, (_, at) => {
  const u = at >> 3;
  const x = at & 7;
  return Math.round(
    4096 * (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16),
  );
});

class Bits {
  public readonly bytes: number[] = [];
  #buffer = 0;
  #count = 0;

  public put(code: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.#buffer = (this.#buffer << 1) | ((code >> bit) & 1);
      this.#count += 1;
      if (this.#count === 8) {
        this.bytes.push(this.#buffer);
        if (this.#buffer === 0xff) this.bytes.push(0);
        this.#buffer = 0;
        this.#count = 0;
      }
    }
  }

  public flush(): void {
    while (this.#count !== 0) this.put(1, 1);
  }
}

/** One component's quantised block, from 64 level-shifted samples in natural order. */
function quantised(samples: readonly number[], quant: readonly number[]): number[] {
  // Along each row, then down each column: F(v, u) = ¼ Σ Σ f(y, x) B(u, x) B(v, y) / 4,096².
  const rows = new Array<number>(64).fill(0);
  for (let y = 0; y < 8; y += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) sum += (samples[y * 8 + x] ?? 0) * (BASIS[u * 8 + x] ?? 0);
      rows[y * 8 + u] = sum;
    }
  }
  const out = new Array<number>(64).fill(0);
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) sum += (rows[y * 8 + u] ?? 0) * (BASIS[v * 8 + y] ?? 0);
      out[v * 8 + u] = Math.round(sum / (4 * 4096 * 4096 * (quant[v * 8 + u] ?? 1)));
    }
  }
  return out;
}

function category(value: number): number {
  let size = 0;
  for (let magnitude = Math.abs(value); magnitude > 0; magnitude >>= 1) size += 1;
  return size;
}

function encodeBlock(
  bits: Bits,
  block: readonly number[],
  previous: number,
  dc: Map<number, [number, number]>,
  ac: Map<number, [number, number]>,
): number {
  const put = (table: Map<number, [number, number]>, symbol: number) => {
    const [code, length] = table.get(symbol) ?? [0, 0];
    bits.put(code, length);
  };
  const putValue = (value: number, size: number) =>
    bits.put(value >= 0 ? value : value + (1 << size) - 1, size);
  const first = block[0] ?? 0;
  const difference = first - previous;
  put(dc, category(difference));
  putValue(difference, category(difference));
  let zeros = 0;
  for (let index = 1; index < 64; index += 1) {
    const value = block[ZIGZAG[index] ?? 0] ?? 0;
    if (value === 0) {
      zeros += 1;
      continue;
    }
    for (; zeros > 15; zeros -= 16) put(ac, 0xf0);
    put(ac, (zeros << 4) | category(value));
    putValue(value, category(value));
    zeros = 0;
  }
  if (zeros > 0) put(ac, 0x00);
  return first;
}

function scaled(table: readonly number[], quality: number): number[] {
  const factor = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return table.map((value) => Math.min(255, Math.max(1, Math.floor((value * factor + 50) / 100))));
}

function segment(marker: number, body: readonly number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
}

function huffmanSegment(tables: [number, Table][]): number[] {
  return segment(
    0xc4,
    tables.flatMap(([id, table]) => [id, ...table.bits, ...table.values]),
  );
}

/**
 * `pixels` — one byte a pixel for gray, three (R, G, B) for colour — as a baseline JPEG of
 * `quality` 1–100.
 */
export function encodeJpeg(
  width: number,
  height: number,
  pixels: Uint8Array,
  components: 1 | 3,
  quality: number,
): Uint8Array {
  const luma = scaled(LUMA, quality);
  const chroma = scaled(CHROMA, quality);
  const bits = new Bits();
  const previous = [0, 0, 0];
  const dcLuma = codes(DC_LUMA);
  const acLuma = codes(AC_LUMA);
  const dcChroma = codes(DC_CHROMA);
  const acChroma = codes(AC_CHROMA);
  for (let blockY = 0; blockY < height; blockY += 8) {
    for (let blockX = 0; blockX < width; blockX += 8) {
      const planes: number[][] = Array.from({ length: components }, () => []);
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const at = Math.min(height - 1, blockY + y) * width + Math.min(width - 1, blockX + x);
          if (components === 1) {
            planes[0]?.push((pixels[at] ?? 0) - 128);
            continue;
          }
          const r = pixels[at * 3] ?? 0;
          const g = pixels[at * 3 + 1] ?? 0;
          const b = pixels[at * 3 + 2] ?? 0;
          // JFIF's YCbCr, in 1/65,536ths, level-shifted.
          planes[0]?.push(((19_595 * r + 38_470 * g + 7_471 * b + 32_768) >> 16) - 128);
          planes[1]?.push((-11_059 * r - 21_709 * g + 32_768 * b + 32_768) >> 16);
          planes[2]?.push((32_768 * r - 27_439 * g - 5_329 * b + 32_768) >> 16);
        }
      }
      planes.forEach((plane, index) => {
        const block = quantised(plane, index === 0 ? luma : chroma);
        previous[index] =
          index === 0
            ? encodeBlock(bits, block, previous[0] ?? 0, dcLuma, acLuma)
            : encodeBlock(bits, block, previous[index] ?? 0, dcChroma, acChroma);
      });
    }
  }
  bits.flush();

  const ids = range(components).map((index) => index + 1);
  return Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...ZIGZAG.map((at) => luma[at] ?? 1)]),
    ...(components === 3 ? segment(0xdb, [1, ...ZIGZAG.map((at) => chroma[at] ?? 1)]) : []),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      components,
      ...ids.flatMap((id) => [id, 0x11, id === 1 ? 0 : 1]),
    ]),
    ...huffmanSegment(
      components === 3
        ? [
            [0x00, DC_LUMA],
            [0x10, AC_LUMA],
            [0x01, DC_CHROMA],
            [0x11, AC_CHROMA],
          ]
        : [
            [0x00, DC_LUMA],
            [0x10, AC_LUMA],
          ],
    ),
    ...segment(0xda, [components, ...ids.flatMap((id) => [id, id === 1 ? 0x00 : 0x11]), 0, 63, 0]),
    ...bits.bytes,
    0xff,
    0xd9,
  ]);
}
