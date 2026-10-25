import type { JsonObject } from './contract.js';

/**
 * The item a run belongs to (platform ADR-0046, Round 19: a flow's items) — the invoke
 * request's `item` (`automation-invoke-request.json`), on every run of a flow whose manifest
 * declares `items`. A person makes an item once, from a file — Resume Screening's are jobs —
 * and its runs then belong to it. The platform sends it; the automation reads it and never
 * returns it.
 *
 * Kept apart from `contract.ts` for the 400-line ceiling, and importing it for types alone, so
 * `isInvokeRequest` can call the guard below without a cycle between the two files.
 */
export interface InvokeItem {
  /** The item's id. */
  id: string;
  /** The values a person gave the item's `items.fields`, by key, each a string. */
  fields: Record<string, string>;
  /**
   * The item's reading: its item run's output, held by the platform to the manifest's
   * `items.outputSchema`. Null on the item run itself — the run that makes the reading.
   */
  reading: JsonObject | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The invoke's `item`, in the shape the published schema closes it to. */
export function isInvokeItem(value: unknown): value is InvokeItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRecord(value.fields) &&
    Object.values(value.fields).every((field) => typeof field === 'string') &&
    (value.reading === null || isRecord(value.reading))
  );
}
