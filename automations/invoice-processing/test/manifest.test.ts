import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SERVED_VERSIONS } from '../src/automation.js';
import { VENDOR_KEY } from '../src/quickbooks-path.js';
import { manifests, manifestsRoot } from './fixtures.js';

/**
 * The v2 manifest as the spec words it (the Invoice Processing update's §2.1 and §2.2; its words
 * final): the name the owner gave it, its category a team kind, QuickBooks optional with the vendor
 * choice, two settings and no paid-personally input (decision 4), five visible step groups, and 24
 * steps — find-payer gone, save-details new — each in plain words. v1 stays beside it, untouched,
 * until it is retired.
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
const manifest = read(2);

test('v2 is the one version this code serves, beside v1', () => {
  assert.deepEqual([...SERVED_VERSIONS], [2]);
  assert.deepEqual(
    manifests.map((each) => each.version),
    [2],
  );
  assert.equal(read(1).display.name, 'Bills & Receipts', 'v1 untouched, registered, immutable');
});

test('Invoice Processing, Accounting: the name, the description, the icon, the price, the trigger', () => {
  assert.equal(manifest.templateId, 'invoice-processing');
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.display, {
    name: 'Invoice Processing',
    description: 'Reads bills and receipts, then saves the details or records them in QuickBooks.',
    category: 'Accounting',
    icon: 'Receipt',
  });
  assert.deepEqual(manifest.pricing, { monthlyPriceUsd: 0 });
  // One field on the run form: no "I paid with my own money", no "Who paid" (decision 4).
  assert.deepEqual(manifest.trigger, {
    kind: 'manual',
    input: [
      {
        key: 'invoiceFile',
        title: 'Document',
        description: 'A PDF or photo of a bill or receipt.',
        control: 'artifact',
        required: false,
      },
    ],
  });
});

test('QuickBooks is optional, chosen in the one connection field; two settings, neither required (U6, U7)', () => {
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
    },
    {
      section: 'rules',
      key: 'holdAboveAmount',
      title: 'Approval limit',
      description: 'Amounts over this wait for approval.',
      control: 'money',
      defaultValue: 500,
      required: false,
    },
    {
      section: 'notifications',
      key: 'notifyEmail',
      title: 'Also email',
      description: 'Gets a short summary of each one.',
      control: 'email',
      required: false,
    },
  ]);
  assert.ok(
    manifest.setup.every((field) => field.required === false),
    'nothing to set up first',
  );
  assert.deepEqual(manifest.requiredCapabilities, ['document-extraction']);
});

test("the five groups a person sees, and the 24 steps, each its kicker, group, title and description in the spec's words", () => {
  assert.deepEqual(manifest.groups, [
    { id: 'received', title: 'Received', description: 'You add a PDF or photo.' },
    { id: 'read', title: 'Read', description: 'AI reads the details.' },
    { id: 'checked', title: 'Checked', description: 'Totals and duplicates are checked.' },
    { id: 'done', title: 'Done', description: 'Saved, or recorded in QuickBooks.' },
    { id: 'emailed', title: 'Emailed', description: 'A summary goes to Also email.' },
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
      [
        'read-company',
        'ACTION',
        'received',
        'QuickBooks checked',
        'Checks QuickBooks is connected.',
      ],
      [
        'read-preferences',
        'ACTION',
        'received',
        'QuickBooks settings read',
        'Reads currency and closed dates.',
      ],
      [
        'find-accounts',
        'ACTION',
        'received',
        'Accounts read',
        'Reads your accounts from QuickBooks.',
      ],
      ['extract', 'AI STEP', 'read', 'Document read', 'AI reads the details.'],
      ['check-document', 'ACTION', 'checked', 'Details checked', 'Checks totals and dates.'],
      ['verify-read', 'AI STEP', 'read', 'Read again', 'Only when something looks wrong.'],
      ['find-vendor', 'ACTION', 'checked', 'Vendor looked up', 'Finds the vendor in QuickBooks.'],
      [
        'find-vendor-company',
        'ACTION',
        'checked',
        'Vendor company looked up',
        'Tries the company name.',
      ],
      [
        'find-similar-vendors',
        'ACTION',
        'checked',
        'Similar vendors looked up',
        'Lists similar names.',
      ],
      [
        'find-customer-name',
        'ACTION',
        'checked',
        'Customer names checked',
        'QuickBooks allows each name once.',
      ],
      [
        'find-employee-name',
        'ACTION',
        'checked',
        'Employee names checked',
        'QuickBooks allows each name once.',
      ],
      [
        'find-duplicate-number',
        'ACTION',
        'checked',
        'Number checked',
        'Looks for the same number.',
      ],
      [
        'find-duplicate-amount',
        'ACTION',
        'checked',
        'Amount checked',
        'Looks for the same amount.',
      ],
      [
        'find-related',
        'ACTION',
        'checked',
        'Related record looked up',
        'Looks for a bill it pays.',
      ],
      [
        'find-other-record',
        'ACTION',
        'checked',
        'Other records checked',
        'Looks for the same purchase.',
      ],
      [
        'decide',
        'ACTION',
        'checked',
        'Record in QuickBooks?',
        'Records it, or waits for approval.',
      ],
      ['confirm-company', 'ACTION', 'done', 'Company checked again', 'After approval.'],
      ['confirm-vendor', 'ACTION', 'done', 'Vendor checked again', 'After approval.'],
      ['create-vendor', 'ACTION', 'done', 'Vendor added', 'Adds the new vendor.'],
      ['confirm-no-duplicate', 'ACTION', 'done', 'Duplicates checked again', 'After approval.'],
      ['create-record', 'ACTION', 'done', 'Recorded in QuickBooks', 'Creates the bill or expense.'],
      ['save-details', 'ACTION', 'done', 'Details saved', 'Saves the details for your team.'],
      ['notify', 'ACTION', 'emailed', 'Summary emailed', 'Sends a summary to Also email.'],
    ],
  );
});

test('its own container: the v2 origin and service account, the rest as v1', () => {
  assert.deepEqual(manifest.service, {
    origin: 'http://invoice-processing-v2.autom8x.internal:8080',
    serviceAccount: 'invoice-processing-v2@autom8x.iam.gserviceaccount.com',
    contractVersion: 1,
    maxConcurrentRuns: 1,
    acceptTimeoutMs: 5000,
    runTimeoutSeconds: 900,
  });
  assert.deepEqual(manifest.artifacts, read(1).artifacts);
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
