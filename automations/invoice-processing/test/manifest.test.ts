import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { JsonObject } from '@autom8x/automation-sdk';

import { SERVED_VERSIONS } from '../src/automation.js';
import { VENDOR_KEY } from '../src/quickbooks-path.js';
import { NONE, QUICKBOOKS, manifests, manifestsRoot } from './fixtures.js';

/**
 * The v4 manifest as the session's spec of 2026-10-17 words it (Build 22, §3, V1): v3's
 * automation, unchanged — its name, price, trigger, QuickBooks choice, approval limit, 22 steps,
 * service and outputSchema — shown in the five steps the owner asked for on build 21 (2026-10-17,
 * verbatim: "1. Upooad Invoice / 2. Connect integration - shows either none or quickbooks … / 3.
 * Then something about AI Processing / 4. Quickbooks updated / 5. Email sent"). The words of steps
 * 3 and 4 are the session's suggestions D2 and D3, which the owner approved ("continue and
 * complete", 21:12Z); the mapping of v3's steps to the five (S18) and the vendor choice titled
 * "Integration" in step 2 with the approval limit in none (S19) are the session's choices. v1, v2
 * and v3 stay beside it, registered, byte for byte, until each is retired.
 */

type Group = Record<string, unknown> & { id: string; title: string };
type Manifest = Record<string, unknown> & {
  version: number;
  display: Record<string, string>;
  trigger: { kind: string; input: Record<string, unknown>[] };
  requiredConnections: Record<string, unknown>[];
  setup: Record<string, unknown>[];
  groups: Group[];
  pipeline: Record<string, string>[];
  service: Record<string, unknown>;
};

const file = (version: number) => join(manifestsRoot, `invoice-processing.v${version}.json`);
const read = (version: number) => JSON.parse(readFileSync(file(version), 'utf8')) as Manifest;
const sha256 = (version: number) =>
  createHash('sha256')
    .update(readFileSync(file(version)))
    .digest('hex');
const manifest = read(4);
const v3 = read(3);

/**
 * A step's title as the clients draw it (the platform's ADR-0041, contract §1 (d)): the title its
 * `titleByConnection` gives the provider the flow's connection field chooses — the field's default
 * when the flow has not chosen — else the group's own title.
 */
function stepTitle(group: Group, config: JsonObject): string {
  const titled = group.titleByConnection as
    { field: string; titles: { providerId: string; title: string }[] } | undefined;
  if (titled === undefined) return group.title;
  const field = manifest.setup.find((each) => each.key === titled.field);
  const chosen = config[titled.field] ?? field?.defaultValue;
  return titled.titles.find((each) => each.providerId === chosen)?.title ?? group.title;
}

test('v4 is the one version this code serves; v1, v2 and v3 stay registered, byte for byte', () => {
  assert.deepEqual([...SERVED_VERSIONS], [4]);
  assert.deepEqual(
    manifests.map((each) => each.version),
    [4],
  );
  assert.deepEqual(
    [1, 2, 3].map(sha256),
    [
      'd712dd7e399e268a030619ca08144fd0249b730211ab5f37b8bc57b853155f25',
      '867b4eca9f022f09bc3cc92a1023719381374631c5041e6842a52777b1feca98',
      '3c7f1134b2c8918b578d08f4f23e5c69daf04ea930aaa3fbf0f14dd993ddcab9',
    ],
    'v1, v2 and v3 untouched: a registered version is immutable',
  );
  assert.equal(
    sha256(4),
    'b07092537297d442538c629b0488ba9810fb752f2e3fc6b0e89202355476d750',
    "v4 is the spec's bytes, which the platform's pin change copies",
  );
  assert.equal(manifest.version, 4);
});

test('the five steps, in order, in their words: Upload invoice · Connect integration · AI processing · Details saved, or QuickBooks updated · Email sent', () => {
  assert.deepEqual(manifest.groups, [
    { id: 'upload', title: 'Upload invoice', description: 'Add a PDF or photo.' },
    { id: 'connect', title: 'Connect integration', description: 'QuickBooks, or None.' },
    { id: 'process', title: 'AI processing', description: 'AI reads and checks each document.' },
    {
      id: 'record',
      title: 'Details saved',
      description: 'Saved, or recorded in QuickBooks.',
      titleByConnection: {
        field: VENDOR_KEY,
        titles: [{ providerId: 'quickbooks', title: 'QuickBooks updated' }],
      },
    },
    {
      id: 'email',
      title: 'Email sent',
      description: 'The results are emailed.',
      platform: 'email',
    },
  ]);
});

test('step 4 says "QuickBooks updated" when the flow chose QuickBooks and "Details saved" with None (D3); no other step changes its title', () => {
  const titles = (config: JsonObject) => manifest.groups.map((group) => stepTitle(group, config));
  assert.deepEqual(titles(QUICKBOOKS), [
    'Upload invoice',
    'Connect integration',
    'AI processing',
    'QuickBooks updated',
    'Email sent',
  ]);
  assert.deepEqual(titles(NONE), [
    'Upload invoice',
    'Connect integration',
    'AI processing',
    'Details saved',
    'Email sent',
  ]);
  assert.deepEqual(titles({}), titles(NONE), 'a flow that has not chosen has None, the default');
});

test('every one of the 22 steps is in exactly one of the five, in their order: receive in 1; nothing in 2; the reads in 3; the other 18 in 4; nothing in 5', () => {
  const ids = manifest.groups.map((group) => group.id);
  const stepsOf = (id: string) =>
    manifest.pipeline.filter((step) => step.group === id).map((step) => step.id);
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, stepsOf(id)])), {
    upload: ['receive'],
    connect: [],
    process: ['extract', 'check-documents', 'verify-read'],
    record: [
      'read-company',
      'read-preferences',
      'find-accounts',
      'find-vendors',
      'find-names',
      'find-duplicates',
      'find-related',
      'decide',
      'create-vendors',
      'create-records',
      'save-documents',
      'ask-approval',
      'confirm-company',
      'confirm-vendors',
      'create-approved-vendors',
      'confirm-no-duplicates',
      'create-approved-records',
      'save-approved',
    ],
    email: [],
  });
  assert.equal(manifest.pipeline.length, 22);
  for (const step of manifest.pipeline) {
    assert.equal(ids.filter((id) => id === step.group).length, 1, `${step.id} in one step`);
  }
  // In the steps' order: a run's progress never goes back a step (S18, contiguous in v3's order).
  const at = manifest.pipeline.map((step) => ids.indexOf(step.group!));
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
  );
});

test('the vendor choice is step 2, titled "Integration", under the key v3 had; the approval limit in no step; no email setting', () => {
  assert.deepEqual(manifest.setup, [
    {
      section: 'connections',
      key: VENDOR_KEY,
      title: 'Integration',
      description: 'Where the details go.',
      control: 'connection',
      defaultValue: 'none',
      required: false,
      providers: ['quickbooks'],
      group: 'connect',
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
  ]);
  // The keys v3's flows carry, unchanged: the platform's move to v4 keeps each setting (S3).
  assert.deepEqual(
    manifest.setup.map((field) => [field.key, field.control, field.defaultValue]),
    v3.setup.map((field) => [field.key, field.control, field.defaultValue]),
  );
  assert.ok(
    manifest.setup.every(
      (field) =>
        field.key !== 'notifyEmail' &&
        field.control !== 'email' &&
        field.section !== 'notifications',
    ),
    "no email setting: who gets a run's results is the platform's (D1), set on step 5's screen",
  );
});

test("nothing else moved from v3: the name, price, trigger, connection, capability, file limits, the 22 steps' words and order, and the outputSchema", () => {
  // v4 less what the spec changes (§3: version, groups, each step's and the vendor's group, the
  // vendor's title, the approval limit's group, the origin and the service account) is v3 less
  // the same, exactly.
  const without = (each: Manifest) => ({
    ...each,
    version: undefined,
    groups: undefined,
    pipeline: each.pipeline.map(({ group: _group, ...step }) => step),
    setup: each.setup.map(({ group: _group, title: _title, ...field }) => field),
    service: { ...each.service, origin: undefined, serviceAccount: undefined },
  });
  assert.deepEqual(without(manifest), without(v3));
  assert.deepEqual(Object.keys(manifest), Object.keys(v3), 'the same keys, in the same order');
  assert.deepEqual(manifest.display, {
    name: 'Invoice Processing',
    description: 'Reads bills and receipts, then saves the details or records them in QuickBooks.',
    category: 'Accounting',
    icon: 'Receipt',
  });
});

test('the 22 steps, each in its step: its kicker, step, title and description as v3 words them', () => {
  assert.deepEqual(
    manifest.pipeline.map(({ id, kicker, group, title, description }) => [
      id,
      kicker,
      group,
      title,
      description,
    ]),
    [
      ['receive', 'TRIGGER', 'upload', 'Document received', 'A PDF or photo arrives.'],
      ['extract', 'AI STEP', 'process', 'Documents read', 'AI reads each document.'],
      ['check-documents', 'ACTION', 'process', 'Documents checked', 'Checks totals and dates.'],
      ['verify-read', 'AI STEP', 'process', 'Read again', 'Only when something looks wrong.'],
      ['read-company', 'ACTION', 'record', 'QuickBooks checked', 'Checks QuickBooks is connected.'],
      [
        'read-preferences',
        'ACTION',
        'record',
        'QuickBooks settings read',
        'Reads currency and closed dates.',
      ],
      [
        'find-accounts',
        'ACTION',
        'record',
        'Accounts read',
        'Reads your accounts from QuickBooks.',
      ],
      ['find-vendors', 'ACTION', 'record', 'Vendors looked up', 'Finds each vendor in QuickBooks.'],
      ['find-names', 'ACTION', 'record', 'Names checked', 'QuickBooks allows each name once.'],
      [
        'find-duplicates',
        'ACTION',
        'record',
        'Duplicates checked',
        'Looks for the same number or amount.',
      ],
      [
        'find-related',
        'ACTION',
        'record',
        'Related records looked up',
        'Looks for a bill it pays.',
      ],
      [
        'decide',
        'ACTION',
        'record',
        'Ready to record?',
        'Records each one, or waits for approval.',
      ],
      ['create-vendors', 'ACTION', 'record', 'Vendors added', 'Adds new vendors.'],
      [
        'create-records',
        'ACTION',
        'record',
        'Recorded in QuickBooks',
        'Creates bills and expenses.',
      ],
      ['save-documents', 'ACTION', 'record', 'Details saved', 'Saves the details for your team.'],
      ['ask-approval', 'ACTION', 'record', 'Needs your approval', 'Waits for your approval.'],
      ['confirm-company', 'ACTION', 'record', 'Company checked again', 'After approval.'],
      ['confirm-vendors', 'ACTION', 'record', 'Vendors checked again', 'After approval.'],
      ['create-approved-vendors', 'ACTION', 'record', 'Approved vendors added', 'After approval.'],
      ['confirm-no-duplicates', 'ACTION', 'record', 'Duplicates checked again', 'After approval.'],
      [
        'create-approved-records',
        'ACTION',
        'record',
        'Approved documents recorded',
        'After approval.',
      ],
      ['save-approved', 'ACTION', 'record', 'Approved details saved', 'After approval.'],
    ],
  );
});

test("its own container: v4's origin and service account; the rest of the service v3's", () => {
  assert.deepEqual(manifest.service, {
    origin: 'http://invoice-processing-v4.autom8x.internal:8080',
    serviceAccount: 'invoice-processing-v4@autom8x.iam.gserviceaccount.com',
    contractVersion: 1,
    maxConcurrentRuns: 1,
    acceptTimeoutMs: 5000,
    runTimeoutSeconds: 900,
  });
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
    manifest.groups.map(({ id: _id, platform: _platform, titleByConnection, ...group }) => ({
      ...group,
      titles: (titleByConnection as { titles: { title: string }[] } | undefined)?.titles.map(
        (each) => each.title,
      ),
    })),
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
    'connect vendor',
  ]) {
    assert.ok(!words.includes(banned), banned);
  }
});
