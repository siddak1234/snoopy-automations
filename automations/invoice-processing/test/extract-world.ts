import { defineAutomation, type InvokeRequest, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { EXTRACT_DOCUMENT_V1 } from '../src/prompts.js';
import { extract } from '../src/steps/extract.js';
import { FILE_ID, completion, pdf } from './fixtures.js';

/**
 * `extract` alone, on the SDK's runner: a first step seeds the state the steps before it
 * leave, then `extract` runs, and the result hands the whole state back — the one place a
 * suite can read what the step kept, since the automation's own result never carries the answer.
 */

/** The accounts `find-accounts` leaves when only the default category is set. */
export const DEFAULT_ACCOUNTS: JsonObject = {
  defaultCategory: { id: '57', fullyQualifiedName: 'Utilities:Electric', accountType: 'Expense' },
  categories: {},
  paidFrom: null,
  teamOwed: null,
  ownerInvestment: null,
  owners: [],
};

/** The state `receive`, `read-company`, `read-preferences`, `find-accounts` and a skipped `find-payer` leave. */
export const SEEDED_STATE: JsonObject = {
  file: { artifactId: FILE_ID, kind: 'pdf', sizeBytes: 184_203, pages: 2, sha256: 'ab'.repeat(32) },
  company: {
    name: 'Sample Bakery',
    legalName: 'Sample Bakery LLC',
    country: 'USA',
    payrollFeature: false,
  },
  preferences: {
    homeCurrency: 'USD',
    multiCurrencyEnabled: false,
    customTxnNumbers: false,
    purchaseCustomTxnNumbers: null,
    warnDuplicateBillNumber: false,
    bookCloseDate: '2025-12-31',
  },
  accounts: DEFAULT_ACCOUNTS,
};

export function extractWorld(seeded: JsonObject = SEEDED_STATE) {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 1,
        requiredCapabilities: ['document-extraction'],
        pipeline: [{ id: 'seed' }, { id: 'extract' }],
      },
    ],
    prompts: [EXTRACT_DOCUMENT_V1],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      extract: extract(EXTRACT_DOCUMENT_V1),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [pdf()];
  platform.model = (_call, model) => Promise.resolve(completion(model));
  const request: InvokeRequest = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 1 });
  return {
    platform,
    request,
    /** The run's final state: what every step kept. */
    async state(): Promise<JsonObject | undefined> {
      const result = await automation.execute(request, platform);
      return result.outcome === 'success' ? result.output : undefined;
    },
  };
}
