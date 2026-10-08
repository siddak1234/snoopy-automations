import type { InvokeRequest, JsonObject } from '../src/contract.js';
import type { Manifest } from '../src/manifest.js';
import { definePrompt } from '../src/prompt.js';
import { type AutomationDefinition, type Step, defineAutomation } from '../src/runner.js';
import { invokeFixture } from '../src/testing.js';

/** The fixtures the runner's two suites share: a template, its manifests, steps and a prompt. */

export const TEMPLATE = 'under-test';

export function manifest(version: number, steps: string[], capabilities: string[] = []): Manifest {
  return {
    templateId: TEMPLATE,
    version,
    requiredCapabilities: capabilities,
    pipeline: steps.map((id) => ({ id })),
  };
}

export const ok =
  (summary: string, state?: JsonObject): Step =>
  () =>
    Promise.resolve(state ? { outcome: 'ok', summary, state } : { outcome: 'ok', summary });

export const extract = definePrompt({
  id: 'extract-invoice',
  version: 1,
  capability: 'document-extraction',
  template: 'Extract the invoice fields from {{reference}}.',
  outputSchema: { type: 'object' },
});

export function define(overrides: Partial<AutomationDefinition> = {}) {
  return defineAutomation({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['receive', 'validate', 'post'])],
    steps: {
      receive: ok('Received', { received: true }),
      validate: ok('Validated'),
      post: ok('Posted'),
    },
    result: (state) => ({ output: { ...state }, summary: 'Done' }),
    ...overrides,
  });
}

export function invoke(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({ templateId: TEMPLATE, templateVersion: 1, ...overrides });
}
