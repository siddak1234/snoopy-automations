import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonObject } from '../src/contract.js';
import { outputSchemaProblem, schemaMismatch } from '../src/output-schema.js';

/**
 * The copy of the platform's `outputSchema` rules (25.3.11, 25.3.10), held to the
 * platform's own verdicts: every sample below is one the platform's
 * `snoopy-backend/test/runs-output-schema.test.ts` asserts against
 * `assertSupportedSchema` and `validateAgainstSchema`, with the same expected answer.
 * A copy that drifts from those answers sends an author's suite one way and
 * production the other, which is what the copy exists to prevent.
 */

const INVOICE = {
  type: 'object',
  properties: {
    vendor: { type: 'string', minLength: 1, maxLength: 120 },
    total: { type: 'number', minimum: 0 },
    currency: { type: 'string', enum: ['USD', 'EUR'] },
    dueDate: { type: 'string', nullable: true, format: 'date' },
    lines: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, amount: { type: 'number' } },
        required: ['description', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['vendor', 'total', 'currency', 'lines'],
  additionalProperties: false,
};

const VALID = {
  vendor: 'Acme',
  total: 120.5,
  currency: 'USD',
  dueDate: null,
  lines: [{ description: 'Widgets', amount: 120.5 }],
};

test('a completion in the declared shape conforms, and each departure names its path and keyword', () => {
  assert.equal(outputSchemaProblem(INVOICE), undefined);
  assert.equal(schemaMismatch(VALID, INVOICE), undefined);

  const cases: [unknown, { path: string; rule: string }][] = [
    [
      { ...VALID, total: 'twelve' },
      { path: '$.total', rule: 'type:number' },
    ],
    [
      { ...VALID, total: -1 },
      { path: '$.total', rule: 'minimum' },
    ],
    [
      { ...VALID, currency: 'GBP' },
      { path: '$.currency', rule: 'enum' },
    ],
    [
      { ...VALID, vendor: '' },
      { path: '$.vendor', rule: 'minLength' },
    ],
    [
      { ...VALID, lines: [] },
      { path: '$.lines', rule: 'minItems' },
    ],
    [
      { ...VALID, lines: [{ description: 'Widgets' }] },
      { path: '$.lines[0]', rule: 'required:amount' },
    ],
    [
      { ...VALID, lines: [{ description: 'Widgets', amount: 1, sku: 'W-1' }] },
      { path: '$.lines[0]', rule: 'additionalProperties' },
    ],
    [
      { ...VALID, memo: 'paid' },
      { path: '$', rule: 'additionalProperties' },
    ],
    [{ vendor: 'Acme' }, { path: '$', rule: 'required:total' }],
    [[VALID], { path: '$', rule: 'type:object' }],
    ['{"vendor":"Acme"}', { path: '$', rule: 'type:object' }],
    [
      { ...VALID, vendor: null },
      { path: '$.vendor', rule: 'type:string' },
    ],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(schemaMismatch(value, INVOICE), expected);
  }
});

test('a mismatch never carries a value from the completion', () => {
  const leaks = [
    schemaMismatch({ ...VALID, 'Globex Corporation': 1 }, INVOICE),
    schemaMismatch({ ...VALID, total: 'ninety-nine thousand' }, INVOICE),
    schemaMismatch({ ...VALID, currency: 'SECRET-CURRENCY' }, INVOICE),
  ];
  const serialised = JSON.stringify(leaks);
  for (const value of ['Globex', 'ninety-nine', 'SECRET']) {
    assert.ok(!serialised.includes(value), `${value} appeared in a mismatch`);
  }
});

test('integer, const, bounds, composition and the type list are held', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer', exclusiveMinimum: 0, maximum: 10 },
      kind: { const: 'invoice' },
      id: { type: ['string', 'integer'] },
      amount: { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 12 }] },
      status: { oneOf: [{ enum: ['open'] }, { enum: ['paid', 'open'] }] },
      ref: { allOf: [{ type: 'string' }, { minLength: 3 }] },
    },
    minProperties: 1,
    maxProperties: 6,
  };
  assert.equal(outputSchemaProblem(schema), undefined);
  const ok = { count: 3, kind: 'invoice', id: 7, amount: '12', status: 'paid', ref: 'abc' };
  assert.equal(schemaMismatch(ok, schema), undefined);

  const cases: [JsonObject, { path: string; rule: string }][] = [
    [{ count: 2.5 }, { path: '$.count', rule: 'type:integer' }],
    [{ count: 0 }, { path: '$.count', rule: 'exclusiveMinimum' }],
    [{ kind: 'receipt' }, { path: '$.kind', rule: 'const' }],
    [{ id: true }, { path: '$.id', rule: 'type:string|integer' }],
    [{ amount: true }, { path: '$.amount', rule: 'anyOf' }],
    // `open` matches both branches: oneOf is exactly one, not at least one.
    [{ status: 'open' }, { path: '$.status', rule: 'oneOf' }],
    [{ ref: 'ab' }, { path: '$.ref', rule: 'allOf[1]:minLength' }],
    [{}, { path: '$', rule: 'minProperties' }],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(schemaMismatch(value, schema), expected);
  }
});

test('a keyword the platform cannot hold a completion to is refused, in its words, naming where it sits', () => {
  const refused: [JsonObject, RegExp][] = [
    [
      { type: 'string', pattern: '^INV-' },
      /^outputSchema uses pattern, which the platform cannot hold a completion to$/u,
    ],
    [{ $ref: '#/definitions/invoice' }, /^outputSchema uses \$ref/u],
    [
      { type: 'object', properties: { id: { type: 'string', pattern: '^INV' } } },
      /^outputSchema\.properties\.id uses pattern/u,
    ],
    [{ type: 'object', patternProperties: { '^x-': {} } }, /uses patternProperties/u],
    [{ not: { type: 'null' } }, /uses not/u],
    [
      { type: 'array', items: [{ type: 'string' }] },
      /^outputSchema\.items must be a schema object$/u,
    ],
    [
      { type: 'number', exclusiveMinimum: true },
      /^outputSchema\.exclusiveMinimum must be a number$/u,
    ],
    [{ type: 'money' }, /^outputSchema\.type names a type the platform does not know$/u],
    [{ anyOf: [] }, /^outputSchema\.anyOf must be a non-empty array of schemas$/u],
    [{ enum: [] }, /^outputSchema\.enum must be a non-empty array$/u],
    [{ required: 'vendor' }, /^outputSchema\.required must be an array of property names$/u],
  ];
  for (const [schema, message] of refused) {
    const problem = outputSchemaProblem(schema);
    assert.ok(
      problem !== undefined && message.test(problem),
      `expected ${JSON.stringify(schema)} to be refused with ${String(message)}, got ${String(problem)}`,
    );
  }
});

test('annotations are ignored, and a schema nested past the bound is refused', () => {
  assert.equal(
    outputSchemaProblem({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Invoice',
      description: 'What the model extracts',
      type: 'object',
      propertyOrdering: ['vendor'],
      properties: { vendor: { type: 'string', description: 'The seller', example: 'Acme' } },
    }),
    undefined,
  );

  let deep: JsonObject = { type: 'string' };
  for (let level = 0; level < 40; level += 1) {
    deep = { type: 'object', properties: { inner: deep } };
  }
  assert.match(outputSchemaProblem(deep) ?? '', /nests deeper than 32 levels/u);
});
