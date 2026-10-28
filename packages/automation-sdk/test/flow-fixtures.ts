import type { ModelCompletion } from '../src/contract.js';
import { defineFlow, type FlowDefinition } from '../src/flow.js';
import { definePrompt } from '../src/prompt.js';
import type { Step } from '../src/steps.js';
import { TEMPLATE, manifest } from './runner-fixtures.js';

/** What the `defineFlow` suites share: a typed prompt, a model's answer, a one-step flow, a read. */
export const classify = definePrompt({
  id: 'classify',
  version: 1,
  capability: 'classification',
  template: 'Which kind of document is this?',
  outputSchema: { type: 'object', properties: { kind: { enum: ['bill'] } }, required: ['kind'] },
});

export const completion = (
  text: string,
  finishReason: ModelCompletion['finishReason'] = 'stop',
) => ({
  text,
  model: 'test-model',
  finishReason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

export function flow(step: Step, overrides: Partial<FlowDefinition> = {}) {
  const logged: unknown[][] = [];
  const automation = defineFlow({
    templateId: TEMPLATE,
    manifests: [manifest(1, ['read'], ['classification'])],
    prompts: [classify],
    steps: { read: step },
    result: (state) => ({ output: state, summary: 'Done' }),
    log: (...line) => void logged.push(line),
    ...overrides,
  });
  return { automation, logged };
}

export const reading: Step = async ({ platform }) => {
  const answer = await platform.callModel(classify, {}, { maxOutputTokens: 4_000 });
  return { outcome: 'ok', summary: 'Read', state: { kind: JSON.parse(answer.text).kind } };
};
