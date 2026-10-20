import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Named import for ajv: it ships CommonJS with `module.exports === exports.default`, and under
// NodeNext a default import is typed as the module namespace (as the repository's own tests do).
import { Ajv2020 } from 'ajv/dist/2020.js';

import { manifestsRoot } from './fixtures.js';

/**
 * The served manifest's `outputSchema` (v6's, v5's, v4's and v3's unchanged — `automations/invoice-processing/test/manifest.test.ts`), compiled as the repository's architecture test compiles
 * schemas — Ajv's 2020-12 draft, strict, every error — to hold each run's output to it: the platform
 * only requires an object, so this is where the description is checked (ip-review
 * design-after-approval-writes-notify-tests.json cross_cutting[5]). And the platform's published
 * `automation-run-result.json` (`contract/schemas`), which every result is held to (B-T10).
 */

const manifest = JSON.parse(
  readFileSync(join(manifestsRoot, 'invoice-processing.v6.json'), 'utf8'),
) as { outputSchema: { properties: { documents: { items: object } } } };

/** One document's output item, as the manifest describes it: v2's shapes, each with its place. */
export const OUTPUT_SCHEMA = manifest.outputSchema.properties.documents.items as {
  oneOf: { properties: Record<string, { items?: { enum?: unknown[] }; enum?: unknown[] }> }[];
};

// The saved shape's nullable fields are type unions (`["string", "null"]`), which strict mode
// admits only when asked.
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
const validateOutput = ajv.compile(manifest.outputSchema);
const validateItem = ajv.compile(OUTPUT_SCHEMA);

/**
 * Fails the test when the run's output — or one document's item of it, with its place or without
 * (`outputOf` in `writes-world.ts` hands v2's suites the item without it) — is not what the
 * manifest's outputSchema describes.
 */
export function assertOutputValid(output: unknown, label = 'the output'): void {
  const isItem = typeof output === 'object' && output !== null && !('documents' in output);
  const valid = isItem ? validateItem({ index: 1, ...(output as object) }) : validateOutput(output);
  const errors = isItem ? validateItem.errors : validateOutput.errors;
  assert.ok(valid, `${label}: ${ajv.errorsText(errors)}`);
}

/** Whether one document's output item is: for the cases a test shows the schema refuses. */
export const outputValid = (output: unknown): boolean =>
  validateItem({ index: 1, ...(output as object) }) === true;

const results = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
const validateResult = results.compile(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'contract',
        'schemas',
        'automation-run-result.json',
      ),
      'utf8',
    ),
  ) as object,
);

/** Fails the test when a result is not what the platform's published schema accepts (B-T10). */
export function assertResultValid(result: unknown, label = 'the result'): void {
  assert.ok(validateResult(result), `${label}: ${results.errorsText(validateResult.errors)}`);
}
