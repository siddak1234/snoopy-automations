import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SERVED_VERSIONS } from '../src/automation.js';
import { VENDOR_KEY } from '../src/quickbooks-path.js';
import { manifests, manifestsRoot } from './fixtures.js';

/**
 * The v3 manifest as the session's spec words it (Build 21, B1–B6, as the owner's AM1–AM8 change
 * it): v2's name, category, price and QuickBooks choice; one setting besides the vendor — the
 * approval limit — and no email setting (AM3: the platform sends each run's results to the person
 * who started it, or the owner and admins); four step groups a person sees, each step inside one;
 * and 22 steps, each done once for every document of the file, in plain words. v1 and v2 stay
 * beside it, registered, untouched, until they are retired.
 */

const read = (version: number) =>
  JSON.parse(
    readFileSync(join(manifestsRoot, `invoice-processing.v${version}.json`), 'utf8'),
  ) as Record<string, unknown> & {
    display: Record<string, string>;
    trigger: { kind: string; input: Record<string, unknown>[] };
    requiredConnections: Record<string, unknown>[];
    setup: Record<string, unknown>[];
    groups: Record<string, string>[];
    pipeline: Record<string, string>[];
    service: Record<string, unknown>;
  };
const manifest = read(3);

test('v3 is the one version this code serves; v1 and v2 stay registered, untouched', () => {
  assert.deepEqual([...SERVED_VERSIONS], [3]);
  assert.deepEqual(
    manifests.map((each) => each.version),
    [3],
  );
  assert.equal(read(1).display.name, 'Bills & Receipts', 'v1 untouched, registered, immutable');
  const v2 = read(2);
  assert.deepEqual(
    [v2.version, v2.pipeline.length, v2.pipeline.at(-1)?.id, v2.service.origin],
    [2, 24, 'notify', 'http://invoice-processing-v2.autom8x.internal:8080'],
    'v2 untouched, registered, immutable',
  );
});

test('Invoice Processing, Accounting: the name, the description, the icon, the price, the trigger', () => {
  assert.equal(manifest.templateId, 'invoice-processing');
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.display, {
    name: 'Invoice Processing',
    description: 'Reads bills and receipts, then saves the details or records them in QuickBooks.',
    category: 'Accounting',
    icon: 'Receipt',
  });
  assert.deepEqual(manifest.pricing, { monthlyPriceUsd: 0 });
  // One field on the run form: the file, of one document or many.
  assert.deepEqual(manifest.trigger, {
    kind: 'manual',
    input: [
      {
        key: 'invoiceFile',
        title: 'Document',
        description: 'A PDF or photo of bills or receipts.',
        control: 'artifact',
        required: false,
      },
    ],
  });
});

test('QuickBooks is optional, chosen in the one connection field; the approval limit the one other setting; no email setting (AM3)', () => {
  assert.deepEqual(manifest.requiredConnections, [
    {
      providerId: 'quickbooks',
      displayName: 'QuickBooks Online',
      purpose: 'Records bills and receipts.',
      scopes: ['com.intuit.quickbooks.accounting'],
      optional: true,
    },
  ]);
  assert.deepEqual(manifest.setup, [
    {
      section: 'connections',
      key: VENDOR_KEY,
      title: 'Vendor',
      description: 'Where the details go.',
      control: 'connection',
      defaultValue: 'none',
      required: false,
      providers: ['quickbooks'],
      group: 'done',
    },
    {
      section: 'rules',
      key: 'holdAboveAmount',
      title: 'Approval limit',
      description: 'Amounts over this wait for approval.',
      control: 'money',
      defaultValue: 500,
      required: false,
      group: 'checked',
    },
  ]);
  assert.ok(
    manifest.setup.every((field) => field.control !== 'email' && field.section !== 'notifications'),
    'no email setting: the results go to the person who started the run, or the owner and admins',
  );
  assert.deepEqual(manifest.requiredCapabilities, ['document-extraction']);
});

test('the four groups a person sees, and the 22 steps, each inside one: its kicker, group, title and description in plain words', () => {
  assert.deepEqual(manifest.groups, [
    { id: 'received', title: 'Received', description: 'Add a PDF or photo.' },
    { id: 'read', title: 'Read', description: 'AI reads each bill or receipt.' },
    { id: 'checked', title: 'Checked', description: 'Totals and duplicates are checked.' },
    { id: 'done', title: 'Done', description: 'Saved, or recorded in QuickBooks.' },
  ]);
  assert.deepEqual(
    manifest.pipeline.map(({ id, kicker, group, title, description }) => [
      id,
      kicker,
      group,
      title,
      description,
    ]),
    [
      ['receive', 'TRIGGER', 'received', 'Document received', 'A PDF or photo arrives.'],
      ['extract', 'AI STEP', 'read', 'Documents read', 'AI reads each document.'],
      ['check-documents', 'ACTION', 'read', 'Documents checked', 'Checks totals and dates.'],
      ['verify-read', 'AI STEP', 'read', 'Read again', 'Only when something looks wrong.'],
      [
        'read-company',
        'ACTION',
        'checked',
        'QuickBooks checked',
        'Checks QuickBooks is connected.',
      ],
      [
        'read-preferences',
        'ACTION',
        'checked',
        'QuickBooks settings read',
        'Reads currency and closed dates.',
      ],
      [
        'find-accounts',
        'ACTION',
        'checked',
        'Accounts read',
        'Reads your accounts from QuickBooks.',
      ],
      [
        'find-vendors',
        'ACTION',
        'checked',
        'Vendors looked up',
        'Finds each vendor in QuickBooks.',
      ],
      ['find-names', 'ACTION', 'checked', 'Names checked', 'QuickBooks allows each name once.'],
      [
        'find-duplicates',
        'ACTION',
        'checked',
        'Duplicates checked',
        'Looks for the same number or amount.',
      ],
      [
        'find-related',
        'ACTION',
        'checked',
        'Related records looked up',
        'Looks for a bill it pays.',
      ],
      [
        'decide',
        'ACTION',
        'checked',
        'Ready to record?',
        'Records each one, or waits for approval.',
      ],
      ['create-vendors', 'ACTION', 'done', 'Vendors added', 'Adds new vendors.'],
      ['create-records', 'ACTION', 'done', 'Recorded in QuickBooks', 'Creates bills and expenses.'],
      ['save-documents', 'ACTION', 'done', 'Details saved', 'Saves the details for your team.'],
      ['ask-approval', 'ACTION', 'done', 'Needs your approval', 'Waits for your approval.'],
      ['confirm-company', 'ACTION', 'done', 'Company checked again', 'After approval.'],
      ['confirm-vendors', 'ACTION', 'done', 'Vendors checked again', 'After approval.'],
      ['create-approved-vendors', 'ACTION', 'done', 'Approved vendors added', 'After approval.'],
      ['confirm-no-duplicates', 'ACTION', 'done', 'Duplicates checked again', 'After approval.'],
      [
        'create-approved-records',
        'ACTION',
        'done',
        'Approved documents recorded',
        'After approval.',
      ],
      ['save-approved', 'ACTION', 'done', 'Approved details saved', 'After approval.'],
    ],
  );
});

test('its own container: the v3 origin and service account; the file of any number of pages (AM1, AM7)', () => {
  assert.deepEqual(manifest.service, {
    origin: 'http://invoice-processing-v3.autom8x.internal:8080',
    serviceAccount: 'invoice-processing-v3@autom8x.iam.gserviceaccount.com',
    contractVersion: 1,
    maxConcurrentRuns: 1,
    acceptTimeoutMs: 5000,
    runTimeoutSeconds: 900,
  });
  const { maximumPdfPages: _pages, ...artifacts } = read(2).artifacts as Record<string, unknown>;
  assert.deepEqual(manifest.artifacts, artifacts);
});

test("the plain-words rule (§3.0 rule 4): no 'solution', 'pipeline', 'provider', 'deployment' in anything a person reads", () => {
  // The words a person reads: every string value, never a key such as `providerId`.
  const values = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : typeof value === 'object' && value !== null
        ? Object.values(value).flatMap(values)
        : [];
  const words = values([
    manifest.display,
    manifest.trigger,
    manifest.requiredConnections,
    manifest.setup,
    manifest.groups,
    manifest.pipeline,
  ])
    .join(' ')
    .toLowerCase();
  for (const banned of [
    'solution',
    'pipeline',
    'provider',
    'deployment',
    'exactly as quickbooks',
  ]) {
    assert.ok(!words.includes(banned), banned);
  }
});
