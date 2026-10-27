import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import type { EmittedBlock } from '../src/block-types.js';
import { BLOCK_LIMITS as L, boundedBlocks } from '../src/blocks.js';
import { assertValid, validator } from './published-schemas.js';

/**
 * What `blocks-bounds.test.ts` and `blocks-bounds-v2.test.ts` share: blocks handed in as anything,
 * and what is sent held to the published `automation-run-result.json` and to the bounds no schema
 * can say — 300 in all (a group, its sections and their blocks counted), 20 images, 96 KiB.
 */

export const FILE = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';

/** A bounded block, read by path: the test reads what it names. */
export type Json = Record<string, any>;

/** What a test hands in: anything, as a model's words or a careless cast could make it. */
export const bound = (blocks: unknown[]): EmittedBlock[] | undefined =>
  boundedBlocks(blocks as EmittedBlock[]);

/** One block in all, as the platform counts it (its `countOf`). */
const counted = (one: EmittedBlock): number =>
  one.type === 'section'
    ? 1 + one.blocks.length
    : one.type === 'group'
      ? one.sections.reduce((sum, each) => sum + counted(each), 1)
      : 1;

/** Every leaf a block holds, as the platform reads it (its `leavesOf`). */
const leaves = (one: EmittedBlock): EmittedBlock[] =>
  one.type === 'section'
    ? [...one.blocks]
    : one.type === 'group'
      ? one.sections.flatMap((each) => each.blocks)
      : [one];

/** Sent as a success's blocks: valid by the schema, and within 300, 20 images and 96 KiB. */
export function sendable(blocks: EmittedBlock[] | undefined): EmittedBlock[] {
  assert.ok(blocks !== undefined, 'something is left to send');
  assertValid(validator('automation-run-result'), { outcome: 'success', blocks }, 'the blocks');
  const total = blocks.reduce((sum, one) => sum + counted(one), 0);
  assert.ok(total <= L.total, `${total} blocks in all`);
  const images = blocks.flatMap(leaves).filter((one) => one.type === 'image').length;
  assert.ok(images <= L.images, `${images} images in all`);
  assert.ok(Buffer.byteLength(JSON.stringify(blocks)) <= L.bytes, 'within 96 KiB');
  return blocks;
}

export const text = (value: string): unknown => ({ type: 'text', text: value });
