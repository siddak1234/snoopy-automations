import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ACCOUNT_SETTINGS, OWNERS_SETTING } from '../src/account-settings.js';
import { CATEGORY_SETTINGS, SPEND_TYPES } from '../src/spend-types.js';
import { CARD_SETTING } from '../src/steps/find-accounts.js';
import { manifestsRoot } from './fixtures.js';

/**
 * The v1 manifest as the owner's plan of 2026-10-11 words it (§3, D13, D30): the display
 * name, what each document becomes, the run's three inputs, every setting the code reads —
 * optional but the default category — and the connection's purpose.
 */

interface Field {
  key: string;
  title: string;
  description: string;
  control: string;
  required: boolean;
  section?: string;
  defaultValue?: unknown;
}
const manifest = JSON.parse(
  readFileSync(join(manifestsRoot, 'invoice-processing.v1.json'), 'utf8'),
) as {
  templateId: string;
  display: { name: string; description: string };
  trigger: { input: Field[] };
  setup: Field[];
  requiredConnections: { purpose: string }[];
  pipeline: { id: string; kicker: string; title: string; description: string }[];
};

test('Bills & Receipts, still the invoice-processing template, says what each document becomes', () => {
  assert.equal(manifest.templateId, 'invoice-processing');
  assert.equal(manifest.display.name, 'Bills & Receipts');
  assert.equal(
    manifest.display.description,
    'Records a bill, receipt or credit note from a PDF or photo in QuickBooks Online: a bill as a bill, a receipt as an expense, a credit note as a vendor credit. Statements are compared, not recorded.',
  );
  assert.equal(
    manifest.requiredConnections[0]?.purpose,
    'Looks up accounts, vendors, customers, employees, bills, expenses, vendor credits and journal entries, and creates vendors, bills, expenses, vendor credits and journal entries.',
  );
});

test('the run asks for the document, and optionally the switch and who paid (D13)', () => {
  assert.deepEqual(
    manifest.trigger.input.map(({ key, title, control, required }) => [
      key,
      title,
      control,
      required,
    ]),
    [
      ['invoiceFile', 'Document', 'artifact', false],
      ['paidPersonally', 'I paid for this with my own money', 'toggle', false],
      ['paidBy', 'Who paid', 'text', false],
    ],
  );
  assert.equal(
    manifest.trigger.input[0]?.description,
    'A bill, receipt, credit note or statement: a PDF, or a JPEG or PNG photo.',
  );
  assert.equal(manifest.trigger.input[1]?.defaultValue, false);
});

test('every setting the code reads is declared, as text, optional but the default category; nineteen in all', () => {
  const byKey = new Map(manifest.setup.map((field) => [field.key, field]));
  for (const setting of ACCOUNT_SETTINGS) {
    const field = byKey.get(setting.key);
    assert.ok(field, setting.key);
    assert.deepEqual(
      [field.title, field.control, field.required],
      [setting.title, 'text', setting.key === 'expenseAccount'],
      setting.key,
    );
  }
  const owners = byKey.get(OWNERS_SETTING.key);
  assert.deepEqual(
    [owners?.title, owners?.control, owners?.required],
    [OWNERS_SETTING.title, 'text', false],
  );
  // The card check's setting: find-accounts holds it to four digits under this key and title.
  const card = byKey.get(CARD_SETTING.key);
  assert.deepEqual(
    [card?.title, card?.control, card?.required],
    [CARD_SETTING.title, 'text', false],
  );
  assert.equal(CARD_SETTING.title, "Company card's last four digits");
  assert.match(card?.description ?? '', /such as 4417: exactly four digits, or left empty\./u);
  assert.deepEqual(
    manifest.setup.map((field) => field.key),
    [
      'holdAboveAmount',
      'expenseAccount',
      'paidFromAccount',
      'companyCardLast4',
      'teamOwedAccount',
      'ownerInvestmentAccount',
      'ownerNames',
      ...CATEGORY_SETTINGS.map((setting) => setting.key),
      'notifyEmail',
    ],
  );
  assert.equal(
    byKey.get('holdAboveAmount')?.description.startsWith('Records over this amount'),
    true,
  );
  assert.equal(byKey.get('expenseAccount')?.title, 'Default category');
  for (const field of manifest.setup) {
    assert.ok(field.title.length <= 200 && field.description.length <= 200, field.key);
    if (field.key !== 'expenseAccount') assert.equal(field.required, false, field.key);
  }
});

test('one category setting per spend type but other, titled "Category for <spend type>"', () => {
  assert.deepEqual(
    CATEGORY_SETTINGS.map((setting) => setting.spendType),
    SPEND_TYPES.filter((type) => type !== 'other'),
  );
  assert.deepEqual(
    CATEGORY_SETTINGS.map((setting) => setting.title),
    [
      'Category for meals',
      'Category for travel',
      'Category for vehicle and fuel',
      'Category for office supplies',
      'Category for software and subscriptions',
      'Category for utilities and phone',
      'Category for rent',
      'Category for repairs and maintenance',
      'Category for professional services',
      'Category for materials',
      'Category for advertising',
    ],
  );
});

test('the pipeline: 18 of the 24 steps the platform allows — the trigger, two AI steps, then actions: the nine lookups and decide last', () => {
  const kinds = manifest.pipeline.map((step) => step.kicker);
  assert.equal(manifest.pipeline.length, 18);
  assert.equal(kinds[0], 'TRIGGER');
  assert.deepEqual(
    manifest.pipeline.filter((step) => step.kicker === 'AI STEP').map((step) => step.id),
    ['extract', 'verify-read'],
  );
  assert.deepEqual(
    manifest.pipeline.slice(8).map((step) => [step.id, step.kicker]),
    [
      ['find-vendor', 'ACTION'],
      ['find-vendor-company', 'ACTION'],
      ['find-similar-vendors', 'ACTION'],
      ['find-customer-name', 'ACTION'],
      ['find-employee-name', 'ACTION'],
      ['find-duplicate-number', 'ACTION'],
      ['find-duplicate-amount', 'ACTION'],
      ['find-related', 'ACTION'],
      ['find-other-record', 'ACTION'],
      ['decide', 'ACTION'],
    ],
  );
  for (const step of manifest.pipeline) {
    assert.match(step.id, /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u);
    assert.ok(step.title.length <= 80 && step.description.length <= 200, step.id);
  }
});
