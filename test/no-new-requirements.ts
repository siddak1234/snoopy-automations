/**
 * No new requirements (Round 22, the platform's BUILD-PLAN 30.15.2). The owner: "connections are
 * optional. why would a user have to connect to update?" A flow on a version moves to the newest
 * by itself only when the newest asks it nothing new (the platform's `planMove` and
 * `requiredConfigComplete`); so a new version of a flow, compared with the flow's newest file at
 * the base (`git show`, never an older file in the tree; with `test/definition-files.ts`'s D8 each
 * merge adds one file a flow, so every step on main is compared once), never:
 *
 * 1. adds a required connection (`optional` not true) to a provider the previous version
 *    required none of; a public provider (`auth: none` in `contract/schemas/platform-menu.json`)
 *    asking no scope is exempt, as the move exempts it;
 * 2. asks a provider the previous version named for a scope it did not ask (a public provider:
 *    any scope at all, as the move counts it);
 * 3. adds a required setting with no `defaultValue`, unless the previous version had the same key
 *    required with no default;
 *
 * unless the flow's spec, `automations/<templateId>/README.md`, gives the reason: a table row whose
 * first cell is the provider id or the setting key and whose last cell is `new in v<n>: <the
 * reason>`, n the new version (read as `test/file-required.ts` reads its rows). Its merge is the
 * owner's approval.
 *
 * Not covered: a setting whose type or choices change so a saved value is dropped. The platform's
 * register line still names such a flow, and its read-back refuses OK while one is left behind.
 */

import { lastCells, type Json } from './file-required.js';

interface Connection {
  providerId: string;
  scopes?: string[];
  optional?: boolean;
}
interface Setting {
  key: string;
  required?: boolean;
  defaultValue?: unknown;
}

const connections = (manifest: Json) => (manifest.requiredConnections ?? []) as Connection[];
const settings = (manifest: Json) => (manifest.setup ?? []) as Setting[];
const requiredWithoutDefault = (field: Setting | undefined) =>
  field?.required === true && field.defaultValue === undefined;

/** Whether the spec gives `new in v<version>: <reason>` on a row whose first cell is `key`. */
export function newReasonFor(spec: string, key: string, version: number): boolean {
  return lastCells(spec, key).some((cell) =>
    new RegExp(`^new in v${version}\\s*:\\s*\\S`, 'iu').test(cell),
  );
}

/**
 * What the rule refuses in a flow's new manifest against its previous one (none for a flow's
 * first version), given its spec's text and the menu's public providers.
 */
export function requirementProblems(
  next: Json,
  previous: Json | undefined,
  spec: string | undefined,
  publicProviders: ReadonlySet<string>,
): string[] {
  if (previous === undefined) return [];
  const version = Number(next.version);
  const where = `manifests/${String(next.templateId)}.v${version}.json`;
  const readme = `automations/${String(next.templateId)}/README.md`;
  const unless = (key: string) =>
    `, unless a row of ${readme} whose first cell is ${key} ends "new in v${version}: <the reason>"`;
  const problems: string[] = [];
  const before = connections(previous);
  for (const connection of connections(next)) {
    const id = connection.providerId;
    const scopes = connection.scopes ?? [];
    const open = publicProviders.has(id);
    if (newReasonFor(spec ?? '', id, version)) continue;
    const named = before.filter((each) => each.providerId === id);
    if (
      connection.optional !== true &&
      !(open && scopes.length === 0) &&
      !named.some((each) => each.optional !== true)
    ) {
      problems.push(
        `${where}: ${id} is a required connection v${previous.version} did not require${unless(id)}`,
      );
      continue;
    }
    const had = new Set(named.flatMap((each) => each.scopes ?? []));
    const more = open ? scopes : scopes.filter((scope) => !had.has(scope));
    if (named.length > 0 && more.length > 0) {
      problems.push(
        `${where}: ${id} asks ${more.join(', ')}, more than v${previous.version} asked${unless(id)}`,
      );
    }
  }
  const earlier = new Map(settings(previous).map((field) => [field.key, field]));
  for (const field of settings(next)) {
    if (!requiredWithoutDefault(field) || requiredWithoutDefault(earlier.get(field.key))) continue;
    if (newReasonFor(spec ?? '', field.key, version)) continue;
    problems.push(
      `${where}: setting ${field.key} is required with no defaultValue, and v${previous.version}'s was not${unless(field.key)}`,
    );
  }
  return problems;
}
