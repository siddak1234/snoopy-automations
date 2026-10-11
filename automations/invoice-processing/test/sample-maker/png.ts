import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Grayscale PNG for the image samples: every row unfiltered, the rows deflated by Node's zlib.
 * zlib's bytes may change with Node's, so a PNG is reproduced by its pixels (`pngScanlines`),
 * not its bytes: a committed sample is rewritten only when what it draws changes.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** The rows as PNG stores them before deflating: a filter byte (0, none), then the row. */
function scanlines(width: number, height: number, gray: Uint8Array): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return raw;
}

export function encodePng(width: number, height: number, gray: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit gray, deflate, adaptive filtering, no interlace
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines(width, height, gray), { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A PNG's header and inflated rows: what it draws, whatever deflated them. */
export function pngScanlines(file: Uint8Array): { header: Buffer; rows: Buffer } {
  const bytes = Buffer.from(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from(SIGNATURE))) throw new Error('not a PNG');
  let header = Buffer.alloc(0);
  const data: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = body;
    if (type === 'IDAT') data.push(body);
    at += length + 12;
  }
  return { header, rows: inflateSync(Buffer.concat(data)) };
}
