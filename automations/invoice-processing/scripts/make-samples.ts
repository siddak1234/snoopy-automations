import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  SAMPLES,
  expectedOf,
  expectedPath,
  sameAsCommitted,
  samplePath,
  sha256,
} from '../test/sample-maker/samples.js';

/**
 * Makes the sample invoices again from `test/sample-maker/`, and writes a file only when what
 * it holds changed — its bytes, or a PNG's pixels — so a committed sample keeps its sha256, and
 * the recordings made of it stay valid, until the drawing itself changes. Run it from the
 * repository root, then `npm run format` for the `expected.json` files:
 *
 *   npx tsx automations/invoice-processing/scripts/make-samples.ts
 */

for (const sample of SAMPLES) {
  const made = sample.make();
  const file = samplePath(sample);
  mkdirSync(dirname(file), { recursive: true });
  const same = sameAsCommitted(sample, made);
  if (!same) writeFileSync(file, made);
  const expected = expectedOf(sample);
  const expectedFile = expectedPath(sample);
  const kept =
    existsSync(expectedFile) &&
    isDeepStrictEqual(JSON.parse(readFileSync(expectedFile, 'utf8')), expected);
  if (!kept) writeFileSync(expectedFile, `${JSON.stringify(expected, null, 2)}\n`);
  const bytes = readFileSync(file);
  console.log(
    `${same ? 'kept   ' : 'written'} ${relative(process.cwd(), file)}  ${bytes.length} bytes  sha256 ${sha256(bytes)}${kept ? '' : '  (expected.json written)'}`,
  );
}
