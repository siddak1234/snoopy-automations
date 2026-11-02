/**
 * A flow's memory per workspace (platform ADR-0048 amendment 3, point 6), copied from the
 * published `automation-memory-get-request.json` and `automation-memory-put-request.json`: a flow
 * whose manifest declares the `memory` capability keeps small values per workspace through two
 * callbacks, `memory-get {key}` → `{value}` (null when absent) and `memory-put {key, value}` →
 * `{keys}`; a `null` value removes the key. Scoped by the run token's workspace and the manifest's
 * `templateId`, so a later version reads what an earlier one wrote. Never shown to a person.
 */

/** The platform's bounds (the menu's `limits.memory`): the 101st key is refused 409 `memory_full`. */
export const MEMORY_LIMITS = { keys: 100, keyLength: 64, valueBytes: 65_536 } as const;

/** A key: 1 to 64 lowercase letters, digits and hyphens (the schemas' `pattern`). */
export const MEMORY_KEY_PATTERN = /^[a-z0-9-]{1,64}$/u;

/** What a step reaches as `platform.memory`. */
export interface FlowMemory {
  /** The value kept under `key`, or null when none is. */
  get(key: string): Promise<unknown>;
  /** Keeps `value` under `key` (null removes it); answers the flow's count of keys after it. */
  put(key: string, value: unknown): Promise<number>;
}

/**
 * Why the platform would refuse this read or write with a 400, in its words, or undefined — what
 * the client and the recording double refuse before anything is sent, so the two cannot disagree.
 */
export function memoryProblem(key: unknown, value?: unknown): string | undefined {
  if (typeof key !== 'string' || !MEMORY_KEY_PATTERN.test(key)) {
    return 'key must be 1 to 64 lowercase letters, digits and hyphens';
  }
  if (value === undefined || value === null) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  return bytes > MEMORY_LIMITS.valueBytes
    ? `value must be at most ${MEMORY_LIMITS.valueBytes} bytes as JSON`
    : undefined;
}
