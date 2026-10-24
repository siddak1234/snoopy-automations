import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { RunResult } from '@autom8x/automation-sdk';
import type { RecordingPlatform } from '@autom8x/automation-sdk/testing';

import { manifest } from './fixtures.js';

/**
 * What a run sends, held to what receives it: the result to the published
 * `automation-run-result.json`, a candidate's output to the manifest's `outputSchema`, and a
 * job's reading to its `items.outputSchema` — which the platform holds an item run's output to.
 */

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemas = resolve(import.meta.dirname, '..', '..', '..', 'contract', 'schemas');
const runResult = ajv.compile(
  JSON.parse(readFileSync(resolve(schemas, 'automation-run-result.json'), 'utf8')) as object,
);
const candidateOutput = ajv.compile(manifest.outputSchema);
const jobReading = ajv.compile(manifest.items.outputSchema);

/** The one result the run reported, as the client bounded it, held to the published schema. */
export function reportedResult(platform: RecordingPlatform): RunResult {
  assert.equal(platform.results.length, 1, 'one result');
  const { runId, result } = platform.results[0]!;
  assert.ok(runResult({ runId, ...result }), ajv.errorsText(runResult.errors));
  return result;
}

export function validOutput(output: unknown): void {
  assert.ok(candidateOutput(output), ajv.errorsText(candidateOutput.errors));
}

export function validReading(reading: unknown): void {
  assert.ok(jobReading(reading), ajv.errorsText(jobReading.errors));
}
