import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type {
  EmittedBlock,
  EmittedLeaf,
  LinksBlock,
  ListItem,
  RunResult,
  SectionBlock,
} from '@autom8x/automation-sdk';
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

/** The sections a result's blocks hold: a candidate's inside its one group, a job's at the top. */
export function sectionsOf(result: RunResult): SectionBlock[] {
  const blocks: readonly EmittedBlock[] = 'blocks' in result ? (result.blocks ?? []) : [];
  return blocks.flatMap((block) =>
    block.type === 'group' ? block.sections : block.type === 'section' ? [block] : [],
  );
}

const leavesOf = (result: RunResult, title: string): readonly EmittedLeaf[] =>
  sectionsOf(result).find((each) => each.title === title)?.blocks ?? [];

/** The rows of a section's lists, in order. */
export const rowsOf = (result: RunResult, title: string): ListItem[] =>
  leavesOf(result, title).flatMap((leaf) => (leaf.type === 'list' ? leaf.items : []));

/** The buttons of a section's `links` blocks, in order. */
export const buttonsOf = (result: RunResult, title: string): LinksBlock['items'][number][] =>
  leavesOf(result, title).flatMap((leaf) => (leaf.type === 'links' ? leaf.items : []));
