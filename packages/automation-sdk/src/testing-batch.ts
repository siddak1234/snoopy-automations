import type { InvokeUnit } from './batch.js';
import type { ArtifactReference, ModelRequest, ProviderRequest } from './contract.js';
import { MEMORY_LIMITS, memoryProblem, type FlowMemory } from './memory.js';
import { refusalFixture } from './problem-fixture.js';
import type { CallbackRefusedError } from './refusals.js';

/**
 * The recording double's answers to the platform round 2 shapes (platform ADR-0048 amendments 3
 * and 4), split from `testing.ts` for the line ceiling and exported with it: the flow's memory, a
 * model request's page range, a keyless provider's fixed query, and a child run's unit.
 */

/**
 * The flow's memory as the platform keeps it, for one workspace and flow: a key or a value it
 * would refuse 400 is refused in the client's words; `null` removes a key; the 101st key is its
 * 409 `memory_full`; and a manifest that does not declare `memory` (`declared` false) its 403
 * `capability_not_declared`. `values` is what a test reads or seeds.
 */
export class RecordingMemory implements FlowMemory {
  public values = new Map<string, unknown>();
  public declared = true;

  public get(key: string): Promise<unknown> {
    const refused = this.#refused('memory-get', key);
    if (refused) return Promise.reject(refused);
    return Promise.resolve(this.values.get(key) ?? null);
  }

  public put(key: string, value: unknown): Promise<number> {
    const refused = this.#refused('memory-put', key, value);
    if (refused) return Promise.reject(refused);
    if (value === null || value === undefined) {
      this.values.delete(key);
    } else {
      if (!this.values.has(key) && this.values.size >= MEMORY_LIMITS.keys) {
        return Promise.reject(
          refusalFixture('memory-put', {
            status: 409,
            code: 'CONFLICT',
            detail: `A flow keeps at most ${MEMORY_LIMITS.keys} keys`,
            details: { reason: 'memory_full' },
          }),
        );
      }
      // Kept as the platform keeps it: JSON, so a test reads back what a later run would.
      this.values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    }
    return Promise.resolve(this.values.size);
  }

  #refused(
    callback: string,
    key: string,
    value?: unknown,
  ): Error | CallbackRefusedError | undefined {
    const problem = memoryProblem(key, value);
    if (problem) return new Error(problem);
    if (this.declared) return undefined;
    return refusalFixture(callback, {
      status: 403,
      code: 'FORBIDDEN',
      detail: 'The run manifest does not declare the memory capability',
      details: { reason: 'capability_not_declared' },
    });
  }
}

/**
 * The platform's 422 for a page range it cannot read of the file the run was given: `pages` on a
 * file that is not a PDF, or past its measured `pageCount` (unmeasured, not checked here).
 */
export function pagesRefusal(
  request: ModelRequest,
  artifacts: readonly ArtifactReference[],
): CallbackRefusedError | undefined {
  const { pages, artifactId } = request;
  if (pages === undefined || artifactId === undefined) return undefined;
  const file = artifacts.find((one) => one.artifactId.toLowerCase() === artifactId.toLowerCase());
  if (file === undefined) return undefined;
  const refused = (detail: string, reason: string) =>
    refusalFixture('model', { status: 422, code: 'BAD_REQUEST', detail, details: { reason } });
  if (file.contentType !== 'application/pdf') {
    return refused('pages is only meaningful for a PDF', 'pages_not_pdf');
  }
  const count = file.pageCount;
  if (typeof count === 'number' && pages.to > count) {
    return refused(`pages must lie within the file's ${count} pages`, 'pages_out_of_range');
  }
  return undefined;
}

/**
 * The platform's 400 `fixed_query` for a call naming a parameter its provider fixes (a keyless
 * provider's `fixedQuery`, as `nppes`' `version`), given `fixed`: `"provider operation"` → names.
 */
export function fixedQueryRefusal(
  request: ProviderRequest,
  fixed: Readonly<Record<string, readonly string[]>>,
): CallbackRefusedError | undefined {
  const names = fixed[`${request.providerId} ${request.operation}`] ?? [];
  const clash = Object.keys(request.input).find((key) => names.includes(key));
  if (clash === undefined) return undefined;
  return refusalFixture('provider', {
    status: 400,
    code: 'BAD_REQUEST',
    detail: `${clash} is fixed by the provider spec for ${request.operation} and must not be sent`,
    details: { reason: 'fixed_query' },
  });
}

/** A child run's unit, as its invoke carries it: `invokeFixture({ unit: unitFixture({ … }) })`. */
export function unitFixture(overrides: Partial<InvokeUnit> = {}): InvokeUnit {
  return {
    parentRunId: '66666666-6666-4666-8666-666666666666',
    index: 0,
    label: 'Unit 1',
    artifacts: [{ artifactId: '33333333-3333-4333-8333-333333333333' }],
    data: {},
    ...overrides,
  };
}
