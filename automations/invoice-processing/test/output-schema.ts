import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Named import for ajv: it ships CommonJS with `module.exports === exports.default`, and under
// NodeNext a default import is typed as the module namespace (as the repository's own tests do).
import { Ajv2020 } from 'ajv/dist/2020.js';

import { manifestsRoot } from './fixtures.js';

/**
 * The manifest's `outputSchema`, compiled as the repository's architecture test compiles schemas —
 * Ajv's 2020-12 draft, strict, every error — to hold each run's output to it: the platform only
 * requires an object, so this is where the description is checked (ip-review
 * design-after-approval-writes-notify-tests.json cross_cutting[5]).
 */

const manifest = JSON.parse(
  readFileSync(join(manifestsRoot, 'invoice-processing.v1.json'), 'utf8'),
) as { outputSchema: object };

/** The manifest's outputSchema, as written. */
export const OUTPUT_SCHEMA = manifest.outputSchema as {
  oneOf: { properties: Record<string, { items?: { enum?: unknown[] }; enum?: unknown[] }> }[];
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(manifest.outputSchema);

/** Fails the test when the run's output is not what the manifest's outputSchema describes. */
export function assertOutputValid(output: unknown, label = 'the output'): void {
  assert.ok(validate(output), `${label}: ${ajv.errorsText(validate.errors)}`);
}

/** Whether it is: for the cases a test shows the schema refuses. */
export const outputValid = (output: unknown): boolean => validate(output) === true;
