import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** The platform's PUBLISHED schemas, vendored at `contract/schemas`. */
export const schemas = resolve(import.meta.dirname, '../../../contract/schemas');

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);

// Compiled once each: Ajv refuses a second schema under the same `$id`.
const compiled = new Map<string, ValidateFunction>();

export function validator(name: string): ValidateFunction {
  const cached = compiled.get(name);
  if (cached) return cached;
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(schemas, `${name}.json`), 'utf8')) as object,
  );
  compiled.set(name, validate);
  return validate;
}

export function assertValid(validate: ValidateFunction, value: unknown, what: string): void {
  assert.ok(validate(value), `${what}: ${ajv.errorsText(validate.errors)}`);
}
