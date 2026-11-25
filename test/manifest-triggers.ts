/**
 * The platform's validator rules for a flow's ways to start that a JSON Schema cannot say (its
 * ADR-0053, Round 22), ported from its `snoopy-backend/packages/contracts/src/manifest-validation.ts`
 * (`validateTriggers`, `validateTrigger`) at `6cc381f`, each refusal as `<path>: <message>` in its
 * words. `test/manifest-rules.ts` adds them to every manifest's. What the schema already refuses —
 * `trigger` and `triggers` together or neither (its `oneOf`), more than 4 ways, an unknown key, a
 * kind or an event outside its `enum` — is left to the schema, which `test/architecture.test.ts`
 * holds every manifest to; the providers that send events and each one's events are the menu's
 * `providerEvents` (`contract/schemas/platform-menu.json`, the platform's `PROVIDER_EVENTS`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
type Add = (path: string, message: string) => void;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const menu = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', 'contract', 'schemas', 'platform-menu.json'),
    'utf8',
  ),
) as { providerEvents?: Record<string, string[]> };

/** Each provider whose events start a run, with its events (the platform's `PROVIDER_EVENTS`). */
export const PROVIDER_EVENTS: Readonly<Record<string, readonly string[]>> =
  menu.providerEvents ?? {};

/** A manifest's ways to start, each with its path: `triggers`, else its one `trigger`. */
export function waysOf(manifest: Json): { path: string; way: Json }[] {
  if (Array.isArray(manifest.triggers)) {
    return manifest.triggers.flatMap((way, at) =>
      isRecord(way) ? [{ path: `triggers[${at}]`, way }] : [],
    );
  }
  return isRecord(manifest.trigger) ? [{ path: 'trigger', way: manifest.trigger }] : [];
}

/** The manual way, a person's start, whose `input` is the start form (ADR-0030, ADR-0053). */
export const manualWay = (manifest: Json): { path: string; way: Json } | undefined =>
  waysOf(manifest).find(({ way }) => way.kind === 'manual');

/**
 * ADR-0053: each way held to its kind's rules — a `provider-event` way names a provider that sends
 * events, declared, and one of its events, and an optional connection only beside another way to
 * start (ADR-0037, kept: a flow only an optional connection's events start never runs without it);
 * `connection` and `event` on no other kind, `input` on the manual one alone — and one way of each
 * kind but `provider-event`, which has one per connection and event.
 */
export function triggerProblems(
  manifest: Json,
  declared: ReadonlySet<unknown>,
  optional: ReadonlySet<unknown>,
  add: Add,
): void {
  const ways = waysOf(manifest);
  const alone = ways.every(
    ({ way }) => way.kind === 'provider-event' && optional.has(way.connection),
  );
  const seen = new Set<string>();
  for (const { path, way } of ways) {
    const hook = way.kind === 'provider-event';
    if (hook) {
      const named = way.connection;
      const events = typeof named === 'string' ? PROVIDER_EVENTS[named] : undefined;
      if (events === undefined) {
        add(
          `${path}.connection`,
          `must name a provider whose events the platform receives: ${Object.keys(PROVIDER_EVENTS).join(', ')}`,
        );
      } else if (!declared.has(named)) {
        add(
          `${path}.connection`,
          'must name a provider listed in requiredConnections; the platform will not subscribe to an undeclared provider',
        );
      } else if (optional.has(named) && alone) {
        add(`${path}.connection`, 'must name a required, not optional, connection');
      }
      if (events !== undefined && !events.includes(way.event as string)) {
        add(
          `${path}.event`,
          `is required when kind is 'provider-event' and must be one of ${String(named)}'s events: ${events.join(', ')}`,
        );
      }
    } else {
      if (way.connection !== undefined) {
        add(`${path}.connection`, "is only meaningful when kind is 'provider-event'");
      }
      if (way.event !== undefined) {
        add(`${path}.event`, "is only meaningful when kind is 'provider-event'");
      }
    }
    if (way.input !== undefined && way.kind !== 'manual') {
      add(`${path}.input`, "is only meaningful when kind is 'manual'");
    }
    if (path === 'trigger') continue;
    const key = hook ? `${String(way.connection)} ${String(way.event)}` : String(way.kind);
    if (seen.has(key)) {
      add(
        `${path}.kind`,
        hook
          ? 'names the connection and event of another entry'
          : 'is the kind of another entry: at most one of each kind',
      );
    }
    seen.add(key);
  }
}
