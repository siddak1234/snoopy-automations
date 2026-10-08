import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { readManifests, type InvokeRequest, type RunResult } from '@autom8x/automation-sdk';
import { invokeFixture } from '@autom8x/automation-sdk/testing';

import { TEMPLATE_ID, define } from '../src/automation.js';

/** What the automation's two suites share: the served manifests, the definition and an invoke. */

export const manifestsRoot = resolve(import.meta.dirname, '../../../manifests');
export const manifests = readManifests(manifestsRoot, TEMPLATE_ID);
export const automation = define(manifests);

export function invoke(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return invokeFixture({
    templateId: TEMPLATE_ID,
    templateVersion: 1,
    config: {},
    input: { vendor: 'Northwind Trading', amount: 120.5, reference: 'INV-1001' },
    ...overrides,
  });
}

/** v2 and later carry `notifyEmail`; v1 declares no such field. */
export function invokeAt(version: number, config: Record<string, unknown> = {}): InvokeRequest {
  return invoke({
    templateVersion: version,
    config: { notifyEmail: 'vendor@example.com', ...config },
  });
}

export function output(result: RunResult): Record<string, unknown> {
  assert.ok(result.outcome === 'success', `expected success, got ${result.outcome}`);
  return result.output ?? {};
}
