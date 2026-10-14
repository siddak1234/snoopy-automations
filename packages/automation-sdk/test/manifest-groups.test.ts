import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { CONNECTION_NONE, isManifest, type Manifest } from '../src/manifest.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * The manifest's additions of platform ADR-0036 and ADR-0037, as the published
 * `automation-manifest.json` holds them: the category one of the team kinds, a connection that may
 * be optional, the `connection` setup control, the visible step groups and each step's group. The
 * rules a schema cannot say — one `connection` field exactly when a connection is optional, every
 * step grouped exactly when groups are declared — are the platform's validator's, and
 * `test/architecture.test.ts` holds this repository's manifests to them.
 */

const reference = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../manifests/invoice-check.v1.json'), 'utf8'),
) as Record<string, unknown> & { display: Record<string, unknown>; pipeline: { id: string }[] };

test('the category is one of the team kinds, spelt exactly', () => {
  const validate = validator('automation-manifest');
  for (const category of ['Accounting', 'Finance', 'HR', 'Customer Support', 'Research']) {
    assertValid(validate, { ...reference, display: { ...reference.display, category } }, category);
  }
  for (const category of ['accounting', 'Bookkeeping', 'Customer support', '']) {
    const verdict = validate({ ...reference, display: { ...reference.display, category } });
    assert.equal(verdict, false, category);
  }
});

test('a connection may be optional, chosen in a setup field whose control is connection', () => {
  const validate = validator('automation-manifest');
  const vendor = {
    section: 'connections',
    key: 'vendor',
    title: 'Vendor',
    description: 'Where the details go.',
    control: 'connection',
    defaultValue: CONNECTION_NONE,
    required: false,
  };
  const connection = {
    providerId: 'quickbooks',
    displayName: 'QuickBooks Online',
    purpose: 'Records bills and receipts.',
    scopes: ['com.intuit.quickbooks.accounting'],
  };
  const optional = {
    ...reference,
    requiredConnections: [{ ...connection, optional: true }],
    setup: [vendor],
  };
  assertValid(validate, optional, 'an optional connection and its choice');
  assertValid(
    validate,
    { ...optional, requiredConnections: [{ ...connection, optional: false }] },
    'optional false',
  );
  assert.equal(
    validate({ ...optional, requiredConnections: [{ ...connection, optional: 'yes' }] }),
    false,
  );
  assert.equal(validate({ ...optional, setup: [{ ...vendor, control: 'select' }] }), false);
  assert.ok(isManifest(optional), 'and the runner reads it');
});

test('a manifest may declare 2 to 6 step groups and name one on each step', () => {
  const validate = validator('automation-manifest');
  const groups = [
    { id: 'received', title: 'Received', description: 'You add a PDF or photo.' },
    { id: 'done', title: 'Done', description: 'Saved, or recorded in QuickBooks.' },
  ];
  const grouped = {
    ...reference,
    groups,
    pipeline: reference.pipeline.map((step, index) => ({
      ...step,
      group: index === 0 ? 'received' : 'done',
    })),
  };
  assertValid(validate, grouped, 'a grouped manifest');
  const read: Manifest | undefined = isManifest(grouped) ? grouped : undefined;
  assert.equal(read?.pipeline[0]?.group, 'received', 'the runner reads each step with its group');
  for (const [what, changed] of [
    ['one group', { groups: groups.slice(0, 1) }],
    [
      'seven groups',
      { groups: Array.from({ length: 7 }, (_, i) => ({ ...groups[0]!, id: `g${i}` })) },
    ],
    ['a title over 40', { groups: [{ ...groups[0]!, title: 'T'.repeat(41) }, groups[1]] }],
    [
      'a description over 120',
      { groups: [groups[0], { ...groups[1]!, description: 'D'.repeat(121) }] },
    ],
    ['an id that is not an id', { groups: [{ ...groups[0]!, id: 'Received' }, groups[1]] }],
    ['another key', { groups: [{ ...groups[0]!, icon: 'Check' }, groups[1]] }],
  ] as const) {
    assert.equal(validate({ ...grouped, ...changed }), false, what);
  }
  const badStep = { ...grouped, pipeline: [{ ...grouped.pipeline[0], group: 'Not An Id' }] };
  assert.equal(validate(badStep), false, "a step's group is an id");
});
