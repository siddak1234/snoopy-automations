import { resolve } from 'node:path';
import { test } from 'node:test';

import { readManifests } from '@autom8x/automation-sdk';
import {
  RecordingPlatform,
  artifactFixture,
  failureDrill,
  invokeFixture,
} from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, WORDS, define } from '../src/automation.js';

/**
 * The shared failure drill (Round 21, D2.5): a missing connection, the vendor down, a malformed
 * AI answer twice and a timeout each end in a result in plain words, never a throw or a raw
 * message; the malformed answer ends "couldn't be used", the template holding no miss. Every new flow's `automations/<id>/test/drill.test.ts`
 * (written by `npm run scaffold`) runs it; `test/conformance.test.ts` requires it.
 */

const manifests = readManifests(resolve(import.meta.dirname, '..'), TEMPLATE_ID);

test('the failure drill: every failure ends in plain words, never a throw or a raw message', async () => {
  await failureDrill(define(manifests), {
    request: invokeFixture({
      templateId: TEMPLATE_ID,
      templateVersion: 1,
      input: { reference: 'DOC-1', artifactId: 'doc-1' },
    }),
    platform: () => {
      const platform = new RecordingPlatform();
      platform.artifacts = [artifactFixture({ artifactId: 'doc-1', filename: 'doc.txt' })];
      platform.bytes = () => new TextEncoder().encode('Invoice from Contoso, total 120.50');
      platform.model = (_call, model) =>
        Promise.resolve({
          text: JSON.stringify({ vendor: 'Contoso', amount: 120.5 }),
          model,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
      return platform;
    },
    words: Object.values(WORDS).join('\n'),
  });
});
