import { QuickBooksSimulator } from '@autom8x/automation-kit/testing';
import { defineAutomation, type InvokeRequest, type JsonObject } from '@autom8x/automation-sdk';
import { RecordingPlatform, invokeFixture, refusalFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID } from '../src/automation.js';
import { chartOf, type ChartState } from '../src/chart.js';
import { EXTRACT_DOCUMENTS_V1 } from '../src/prompts.js';
import { extract } from '../src/run/extract.js';
import { FILE_ID, completion, pdf } from './fixtures.js';

/**
 * `extract` alone, on the SDK's runner: a first step seeds the state the steps before it
 * leave, then `extract` runs, and the result hands the whole state back — the one place a
 * suite can read what the step kept of each document's read.
 */

/** The simulator's made-up company's chart, as `find-accounts` keeps it. */
export const CHART: ChartState = chartOf(
  new QuickBooksSimulator({ refusal: refusalFixture }).company.accounts,
  false,
);

/** The state `receive` leaves, and on the QuickBooks path `read-company`, `read-preferences` and `find-accounts`. */
export const SEEDED_STATE: JsonObject = {
  file: { artifactId: FILE_ID, kind: 'pdf', sizeBytes: 184_203, pages: 2, sha256: 'ab'.repeat(32) },
  company: {
    name: 'Sample Bakery',
    legalName: 'Sample Bakery LLC',
    country: 'USA',
  },
  preferences: {
    homeCurrency: 'USD',
    multiCurrencyEnabled: false,
    customTxnNumbers: false,
    purchaseCustomTxnNumbers: null,
    warnDuplicateBillNumber: false,
    bookCloseDate: '2025-12-31',
  },
  chart: CHART as unknown as JsonObject,
};

export function extractWorld(seeded: JsonObject = SEEDED_STATE) {
  const automation = defineAutomation({
    templateId: TEMPLATE_ID,
    manifests: [
      {
        templateId: TEMPLATE_ID,
        version: 3,
        requiredCapabilities: ['document-extraction'],
        pipeline: [{ id: 'seed' }, { id: 'extract' }],
      },
    ],
    prompts: [EXTRACT_DOCUMENTS_V1],
    steps: {
      seed: () => Promise.resolve({ outcome: 'ok', summary: 'Seeded', state: seeded }),
      extract: extract(EXTRACT_DOCUMENTS_V1),
    },
    result: (state) => ({ output: state }),
  });
  const platform = new RecordingPlatform();
  platform.artifacts = [pdf()];
  platform.model = (_call, model) => Promise.resolve(completion(model));
  const request: InvokeRequest = invokeFixture({ templateId: TEMPLATE_ID, templateVersion: 3 });
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
