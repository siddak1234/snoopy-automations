import { isObject, type JsonObject } from './contract.js';

/**
 * The platform's `outputSchema` rules, copied — BUILD-PLAN 25.3.11 and 25.3.10.
 *
 * The platform holds a completion to the schema a model request declares, and its
 * keyword set is closed: a schema using anything else is refused 400 before any
 * call, naming the keyword (`snoopy-backend/apps/runs/src/output-schema.ts`, its
 * BUILD-PLAN 25.2.3). `definePrompt` checks a prompt's schema against the same set
 * when the prompt loads, so a `pattern` or a `$ref` fails the automation's own
 * conformance test instead of its first live call; and `RecordingPlatform` holds a
 * test's answer to the schema as the platform would, so a suite fails where
 * production would.
 *
 * A copy, not an import: nothing here may depend on `@snoopy/*` (CLAUDE.md rule 3).
 * The messages and the order of the checks are the platform's, word for word, and
 * `test/output-schema.test.ts` holds the copy to the platform's verdicts sample by
 * sample. `pattern` is refused there on purpose — a regular expression from a
 * container is a denial-of-service vector against the platform's event loop — and so
 * it is refused here.
 */

/** Keywords the platform holds a value to. */
const VALIDATED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'nullable',
  'anyOf',
  'oneOf',
  'allOf',
]);

/** Keywords JSON Schema defines as annotations: read by people and vendors, never by validity. */
const ANNOTATIONS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'example',
  'format',
  'propertyOrdering',
  '$schema',
  '$id',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** Deeper than any extraction result needs; shallow enough that a hostile schema cannot recurse the stack. */
const MAXIMUM_DEPTH = 32;

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Where a value departs from its schema: a JSON path from `$`, and the keyword that failed. */
export interface SchemaMismatch {
  path: string;
  rule: string;
}

type Schema = Record<string, unknown>;

/**
 * Why the platform would refuse this schema, in its words, or undefined when it holds
 * a completion to it. `field` names the schema's place, as the platform's message does.
 */
export function outputSchemaProblem(
  schema: JsonObject,
  field = 'outputSchema',
): string | undefined {
  return walkSchema(schema, field, 0);
}

function walkSchema(schema: unknown, at: string, depth: number): string | undefined {
  if (depth > MAXIMUM_DEPTH) return `${at} nests deeper than ${MAXIMUM_DEPTH} levels`;
  if (!isObject(schema)) return `${at} must be a schema object`;

  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    if (!VALIDATED.has(keyword)) {
      return `${at} uses ${keyword}, which the platform cannot hold a completion to`;
    }
    const problem = keywordProblem(keyword, value, at, depth);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function keywordProblem(
  keyword: string,
  value: unknown,
  at: string,
  depth: number,
): string | undefined {
  switch (keyword) {
    case 'properties':
      if (!isObject(value)) return `${at}.properties must be an object`;
      for (const [name, sub] of Object.entries(value)) {
        const problem = walkSchema(sub, `${at}.properties.${name}`, depth + 1);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case 'items':
      // One schema for every element; the tuple form is refused as a non-object.
      return walkSchema(value, `${at}.items`, depth + 1);
    case 'additionalProperties':
      return typeof value === 'boolean'
        ? undefined
        : walkSchema(value, `${at}.additionalProperties`, depth + 1);
    case 'anyOf':
    case 'oneOf':
    case 'allOf':
      if (!Array.isArray(value) || value.length === 0) {
        return `${at}.${keyword} must be a non-empty array of schemas`;
      }
      for (const [index, sub] of value.entries()) {
        const problem = walkSchema(sub, `${at}.${keyword}[${index}]`, depth + 1);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case 'type':
      for (const type of Array.isArray(value) ? value : [value]) {
        if (typeof type !== 'string' || !TYPES.has(type)) {
          return `${at}.type names a type the platform does not know`;
        }
      }
      return undefined;
    case 'required':
      return Array.isArray(value) && value.every((name) => typeof name === 'string')
        ? undefined
        : `${at}.required must be an array of property names`;
    case 'enum':
      return Array.isArray(value) && value.length > 0
        ? undefined
        : `${at}.enum must be a non-empty array`;
    case 'nullable':
      return typeof value === 'boolean' ? undefined : `${at}.nullable must be a boolean`;
    case 'const':
      return undefined;
    default:
      // The numeric bounds; draft-04's boolean `exclusiveMinimum` is refused here.
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : `${at}.${keyword} must be a number`;
  }
}

/**
 * The first place the value departs from the schema, or undefined when it conforms —
 * the platform's check, in its order. Call `outputSchemaProblem` first: this reads
 * only the keywords that function admits.
 */
export function schemaMismatch(value: unknown, schema: JsonObject): SchemaMismatch | undefined {
  return check(value, schema, '$');
}

function check(value: unknown, schema: Schema, path: string): SchemaMismatch | undefined {
  if (value === null && schema.nullable === true) return undefined;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => isType(value, type))) {
      return { path, rule: `type:${types.join('|')}` };
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return { path, rule: 'const' };
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
    return { path, rule: 'enum' };
  }
  const combined = combinedMismatch(value, schema, path);
  if (combined) return combined;

  if (typeof value === 'number') {
    const bound = numericMismatch(value, schema);
    if (bound) return { path, rule: bound };
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { path, rule: 'minLength' };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { path, rule: 'maxLength' };
    }
  }
  if (Array.isArray(value)) return arrayMismatch(value, schema, path);
  if (isObject(value)) return objectMismatch(value, schema, path);
  return undefined;
}

function combinedMismatch(
  value: unknown,
  schema: Schema,
  path: string,
): SchemaMismatch | undefined {
  if (Array.isArray(schema.allOf)) {
    for (const [index, sub] of (schema.allOf as Schema[]).entries()) {
      const mismatch = check(value, sub, path);
      if (mismatch) return { path: mismatch.path, rule: `allOf[${index}]:${mismatch.rule}` };
    }
  }
  if (
    Array.isArray(schema.anyOf) &&
    !(schema.anyOf as Schema[]).some((sub) => check(value, sub, path) === undefined)
  ) {
    return { path, rule: 'anyOf' };
  }
  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as Schema[]).filter(
      (sub) => check(value, sub, path) === undefined,
    ).length;
    if (matching !== 1) return { path, rule: 'oneOf' };
  }
  return undefined;
}

function arrayMismatch(value: unknown[], schema: Schema, path: string): SchemaMismatch | undefined {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    return { path, rule: 'minItems' };
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    return { path, rule: 'maxItems' };
  }
  if (isObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      const mismatch = check(item, schema.items, `${path}[${index}]`);
      if (mismatch) return mismatch;
    }
  }
  return undefined;
}

function objectMismatch(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
): SchemaMismatch | undefined {
  const keys = Object.keys(value);
  if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
    return { path, rule: 'minProperties' };
  }
  if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
    return { path, rule: 'maxProperties' };
  }
  const properties: Schema = isObject(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    // The name is the schema's own, declared by the automation — never the output's.
    for (const name of schema.required as string[]) {
      if (!Object.hasOwn(value, name)) return { path, rule: `required:${name}` };
    }
  }
  for (const [name, sub] of Object.entries(properties)) {
    if (!Object.hasOwn(value, name) || !isObject(sub)) continue;
    const mismatch = check(value[name], sub, `${path}.${name}`);
    if (mismatch) return mismatch;
  }
  if (schema.additionalProperties === undefined || schema.additionalProperties === true) {
    return undefined;
  }
  for (const name of keys) {
    if (Object.hasOwn(properties, name)) continue;
    // The object's path, not the key's: the key is the model's output.
    if (schema.additionalProperties === false) return { path, rule: 'additionalProperties' };
    if (isObject(schema.additionalProperties)) {
      const mismatch = check(value[name], schema.additionalProperties, path);
      if (mismatch) return { path, rule: `additionalProperties:${mismatch.rule}` };
    }
  }
  return undefined;
}

function numericMismatch(value: number, schema: Schema): string | undefined {
  if (typeof schema.minimum === 'number' && value < schema.minimum) return 'minimum';
  if (typeof schema.maximum === 'number' && value > schema.maximum) return 'maximum';
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    return 'exclusiveMinimum';
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    return 'exclusiveMaximum';
  }
  return undefined;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** Structural equality for `enum` and `const`, with object keys in a canonical order. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}
