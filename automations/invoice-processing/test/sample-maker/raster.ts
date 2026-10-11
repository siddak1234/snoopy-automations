import { ADVANCE, DESCENDERS, glyphCells } from './font.js';

/**
 * A grayscale page for the image samples, and what makes it look scanned, photographed or
 * hand-written. Integer arithmetic throughout, and a seeded generator for every random
 * choice, so the same bytes come out on every machine (a sine or cosine is rounded to 1/65,536
 * before it is used).
 */

/** mulberry32: a small seeded generator of 32-bit integers. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

export interface TextStyle {
  /** Pixels per font cell. */
  readonly scale?: number;
  /** The gray of the ink, 0 black to 255 paper. */
  readonly ink?: number;
  /** Each cell drawn twice, one pixel apart. */
  readonly bold?: boolean;
  /** Painted over what is there, so light text shows on a dark bar. */
  readonly light?: boolean;
  /** Hand-printed: each glyph shifted, slanted, inked and stroked a little differently. */
  readonly hand?: () => number;
}

export class Canvas {
  public readonly data: Uint8Array;

  public constructor(
    public readonly width: number,
    public readonly height: number,
    paper = 255,
  ) {
    this.data = new Uint8Array(width * height).fill(paper);
  }

  /** A rectangle of one gray. */
  public fill(x: number, y: number, width: number, height: number, gray: number): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(this.width, x + width); column += 1) {
        this.data[row * this.width + column] = gray;
      }
    }
  }

  /** Ink over what is there: a pixel only darkens, unless `over` paints it. */
  public ink(x: number, y: number, size: number, gray: number, over = false): void {
    for (let row = y; row < y + size; row += 1) {
      for (let column = x; column < x + size; column += 1) {
        if (row < 0 || column < 0 || row >= this.height || column >= this.width) continue;
        const at = row * this.width + column;
        this.data[at] = over ? gray : Math.min(this.data[at] ?? 255, gray);
      }
    }
  }

  /** `text` with its top-left cell at (x, y); the width it took, in pixels. */
  public text(x: number, y: number, text: string, style: TextStyle = {}): number {
    const scale = style.scale ?? 2;
    const hand = style.hand;
    [...text].forEach((character, index) => {
      let left = x + index * ADVANCE * scale;
      let top = y;
      let gray = style.ink ?? 20;
      let pen = scale;
      if (hand) {
        left += (hand() % 3) - 1;
        top += (hand() % 5) - 2;
        gray = 25 + (hand() % 45);
        pen = scale + 1;
      }
      const drop = DESCENDERS.has(character) ? 2 * scale : 0;
      for (const [column, row] of glyphCells(character)) {
        // A hand slants: the top of a glyph sits a quarter of its height to the right.
        const slant = hand ? Math.floor(((6 - row) * scale) / 4) : 0;
        const px = left + column * scale + slant;
        const py = top + drop + row * scale;
        this.ink(px, py, pen, gray, style.light);
        if (style.bold) this.ink(px + 1, py, pen, gray, style.light);
      }
    });
    return [...text].length * ADVANCE * scale;
  }

  /** Grain: every pixel moved by up to `amplitude` either way. */
  public grain(random: () => number, amplitude: number): void {
    const span = amplitude * 2 + 1;
    for (let at = 0; at < this.data.length; at += 1) {
      const value = (this.data[at] ?? 0) + (random() % span) - amplitude;
      this.data[at] = Math.max(0, Math.min(255, value));
    }
  }

  /** Dust: `count` dark specks of one or two pixels. */
  public dust(random: () => number, count: number): void {
    for (let speck = 0; speck < count; speck += 1) {
      this.ink(
        random() % this.width,
        random() % this.height,
        1 + (random() % 2),
        60 + (random() % 80),
      );
    }
  }

  /** A 3 x 3 box blur: the softness of a scanner or a phone lens. */
  public blur(): void {
    const source = Uint8Array.from(this.data);
    for (let y = 1; y < this.height - 1; y += 1) {
      for (let x = 1; x < this.width - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) sum += source[(y + dy) * this.width + x + dx] ?? 0;
        }
        this.data[y * this.width + x] = Math.floor((sum + 4) / 9);
      }
    }
  }

  /** This page turned by `degrees` about its centre, on `background`, sampled bilinearly. */
  public rotated(degrees: number, background: number): Canvas {
    const out = new Canvas(this.width, this.height, background);
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.round(Math.cos(radians) * 65_536);
    const sin = Math.round(Math.sin(radians) * 65_536);
    const centreX = this.width * 32_768;
    const centreY = this.height * 32_768;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const dx = x * 65_536 + 32_768 - centreX;
        const dy = y * 65_536 + 32_768 - centreY;
        // Where this pixel came from, in 1/65,536 of a pixel.
        const sourceX = Math.floor((cos * dx + sin * dy) / 65_536) + centreX - 32_768;
        const sourceY = Math.floor((cos * dy - sin * dx) / 65_536) + centreY - 32_768;
        const x0 = Math.floor(sourceX / 65_536);
        const y0 = Math.floor(sourceY / 65_536);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= this.width || y0 + 1 >= this.height) continue;
        const fx = (sourceX - x0 * 65_536) >> 8;
        const fy = (sourceY - y0 * 65_536) >> 8;
        const at = y0 * this.width + x0;
        const top = (this.data[at] ?? 0) * (256 - fx) + (this.data[at + 1] ?? 0) * fx;
        const bottom =
          (this.data[at + this.width] ?? 0) * (256 - fx) +
          (this.data[at + this.width + 1] ?? 0) * fx;
        out.data[y * this.width + x] = (top * (256 - fy) + bottom * fy + 32_768) >> 16;
      }
    }
    return out;
  }

  /** `page` copied onto this one with its top-left corner at (x, y). */
  public paste(page: Canvas, x: number, y: number): void {
    for (let row = 0; row < page.height; row += 1) {
      for (let column = 0; column < page.width; column += 1) {
        const tx = x + column;
        const ty = y + row;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        this.data[ty * this.width + tx] = page.data[row * page.width + column] ?? 0;
      }
    }
  }

  /** Uneven light: darker by up to `depth` 256ths toward the edges, as under a phone. */
  public shade(depth: number): void {
    const halfWidth = this.width >> 1;
    const halfHeight = this.height >> 1;
    const reach = halfWidth * halfWidth + halfHeight * halfHeight;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const dx = x - halfWidth;
        const dy = y - halfHeight + (this.height >> 3);
        const dim = Math.floor((depth * (dx * dx + dy * dy)) / reach);
        const at = y * this.width + x;
        this.data[at] = ((this.data[at] ?? 0) * (256 - Math.min(255, dim))) >> 8;
      }
    }
  }

  /** The page as RGB, warmed the way paper is under indoor light. */
  public warm(): Uint8Array {
    const rgb = new Uint8Array(this.data.length * 3);
    this.data.forEach((gray, at) => {
      rgb[at * 3] = gray;
      rgb[at * 3 + 1] = (gray * 244) >> 8;
      rgb[at * 3 + 2] = (gray * 218) >> 8;
    });
    return rgb;
  }
}
