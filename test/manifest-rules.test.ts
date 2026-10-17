import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The platform's validator rules a JSON Schema cannot say, for the manifest additions of its
 * ADR-0037 (spec §1.2 and §1.4 of the Invoice Processing update) and its ADR-0040 (Build 21, C4:
 * one connection per step): an optional connection and the connection setup fields that choose it,
 * a setup field's step group, and the visible step groups — ported from its
 * `packages/contracts/src/manifest-validation.ts` (PR #210's `9516c0e`, then the Build 21 branch
 * `round-17/b21-platform`), each refusal as `<path>: <message>` in its words, so a manifest that
 * would be refused at registration fails this repository first. Every manifest in `manifests/` is
 * held to them.
 */

const manifestsRoot = resolve(import.meta.dirname, '..', 'manifests');

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** Every refusal the rules give, as `<path>: <message>`; none for a manifest that passes. */
export function manifestProblems(manifest: Json): string[] {
  const problems: string[] = [];
  const add = (path: string, message: string) => problems.push(`${path}: ${message}`);
  const connections = list(manifest.requiredConnections);
  const pipeline = list(manifest.pipeline);
  // §1.2 — an optional connection and the flow's choice of it.
  const optional = new Set<unknown>();
  for (const [index, connection] of connections.entries()) {
    if (connection.optional !== undefined && typeof connection.optional !== 'boolean') {
      add(`requiredConnections[${index}].optional`, 'must be a boolean');
    }
    if (connection.optional === true) optional.add(connection.providerId);
  }
  const trigger = (manifest.trigger ?? {}) as Json;
  if (trigger.kind === 'provider-event' && optional.has(trigger.connection)) {
    add('trigger.connection', 'must name a required, not optional, connection');
  }
  // ADR-0040 — one connection field per step that uses one, each naming its providers.
  const fields: { path: string; providers: string[] | undefined }[] = [];
  for (const [index, field] of list(manifest.setup).entries()) {
    const path = `setup[${index}]`;
    const providers = fieldProviders(field, path, optional, add);
    if (field.control !== 'connection') continue;
    if (field.section !== 'connections') {
      add(`${path}.section`, "must be 'connections' for a connection control");
    }
    if (field.required !== false) add(`${path}.required`, 'must be false for a connection control');
    if (field.defaultValue !== 'none') {
      add(`${path}.defaultValue`, "must be 'none' for a connection control");
    }
    fields.push({ path, providers });
    if (optional.size === 0) {
      add(`${path}.control`, 'is only meaningful when requiredConnections has an optional entry');
    }
  }
  if (manifest.setup !== undefined && optional.size > 0 && fields.length === 0) {
    add('setup', "an optional connection needs one setup field with control 'connection'");
  }
  coverage(fields, optional, add);
  // §1.4 — the visible step groups.
  let declared: string[] | undefined;
  if (manifest.groups !== undefined) {
    const groups = list(manifest.groups);
    if (groups.length < 2) add('groups', 'must declare at least 2 groups');
    if (groups.length > 6) add('groups', 'must hold at most 6 items');
    declared = [];
    for (const [index, group] of groups.entries()) {
      const id = String(group.id);
      if (declared.includes(id)) add(`groups[${index}].id`, 'is declared more than once');
      declared.push(id);
    }
  }
  for (const [index, step] of pipeline.entries()) {
    const path = `pipeline[${index}].group`;
    if (declared === undefined) {
      if (step.group !== undefined) add(path, 'group is only meaningful when groups are declared');
    } else if (step.group === undefined) {
      add(path, 'every step needs a group when groups are declared');
    } else if (typeof step.group !== 'string' || !declared.includes(step.group)) {
      add(path, 'must name a declared group');
    } else if (index === 0 && step.group !== declared[0]) {
      add(path, 'the trigger step belongs to the first group');
    }
  }
  for (const [index, id] of (declared ?? []).entries()) {
    if (!pipeline.some((step) => step.group === id))
      add(`groups[${index}]`, `group '${id}' has no step`);
  }
  // ADR-0040 — a setting may say which step it is drawn in.
  for (const [index, field] of list(manifest.setup).entries()) {
    if (field.group === undefined) continue;
    const path = `setup[${index}].group`;
    if (declared === undefined) add(path, 'group is only meaningful when groups are declared');
    else if (typeof field.group !== 'string' || !declared.includes(field.group)) {
      add(path, 'must name a declared group');
    }
  }
  return problems;
}

type Add = (path: string, message: string) => void;

/** A field's `providers`: only on a connection field, 1–16 distinct optional connections. */
function fieldProviders(
  field: Json,
  path: string,
  optional: ReadonlySet<unknown>,
  add: Add,
): string[] | undefined {
  const raw = field.providers;
  if (raw === undefined) return undefined;
  if (field.control !== 'connection') {
    add(`${path}.providers`, 'is only meaningful on a connection control');
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) {
    add(`${path}.providers`, 'must name 1 to 16 providers');
    return undefined;
  }
  const named: string[] = [];
  raw.forEach((providerId: unknown, index) => {
    const at = `${path}.providers[${index}]`;
    if (typeof providerId !== 'string' || !optional.has(providerId)) {
      add(at, 'must name optional connections only');
    } else if (named.includes(providerId)) add(at, 'is declared more than once');
    else named.push(providerId);
  });
  return named;
}

/** Every optional connection chosen by exactly one field, or by a manifest's one field naming none. */
function coverage(
  fields: readonly { path: string; providers: string[] | undefined }[],
  optional: ReadonlySet<unknown>,
  add: Add,
): void {
  if (fields.length === 0) return;
  if (fields.length > 1) {
    for (const field of fields) {
      if (field.providers === undefined) {
        add(
          `${field.path}.providers`,
          'with more than one connection field, each must name its providers',
        );
      }
    }
  }
  const namedBy = new Set<string>();
  for (const field of fields) {
    field.providers?.forEach((providerId, index) => {
      if (namedBy.has(providerId)) {
        add(
          `${field.path}.providers[${index}]`,
          `names ${providerId}, which another connection field names`,
        );
      } else namedBy.add(providerId);
    });
  }
  if (fields.length === 1 && fields[0]?.providers === undefined) return;
  for (const providerId of optional) {
    if (!namedBy.has(String(providerId))) {
      add('setup', `optional connection '${String(providerId)}' is chosen by no connection field`);
    }
  }
}

const read = (file: string) =>
  JSON.parse(readFileSync(join(manifestsRoot, file), 'utf8')) as Json & {
    pipeline: Json[];
    groups?: Json[];
    setup: Json[];
    requiredConnections: Json[];
  };

test('every manifest here passes the rules the platform adds beyond the schema', () => {
  for (const file of readdirSync(manifestsRoot).filter((name) => name.endsWith('.json'))) {
    assert.deepEqual(manifestProblems(read(file)), [], `manifests/${file}`);
  }
});

test('the rules refuse what the platform refuses', () => {
  const v2 = read('invoice-processing.v2.json');
  const [vendor, ...settings] = v2.setup as [Json, ...Json[]];
  const [quickBooks] = v2.requiredConnections as [Json];
  const cases: [string, Json, string][] = [
    [
      'an optional connection with no choice',
      { ...v2, setup: settings },
      "setup: an optional connection needs one setup field with control 'connection'",
    ],
    [
      'two choices, neither naming its providers',
      { ...v2, setup: [vendor, { ...vendor, key: 'other' }, ...settings] },
      'setup[1].providers: with more than one connection field, each must name its providers',
    ],
    [
      'providers on a setting that is no connection',
      { ...v2, setup: [vendor, { ...settings[0]!, providers: ['quickbooks'] }] },
      'setup[1].providers: is only meaningful on a connection control',
    ],
    [
      'a provider that is not optional',
      { ...v2, setup: [{ ...vendor, providers: ['google'] }, ...settings] },
      'setup[0].providers[0]: must name optional connections only',
    ],
    [
      'one provider chosen by two fields',
      {
        ...v2,
        setup: [
          { ...vendor, providers: ['quickbooks'] },
          { ...vendor, key: 'other', providers: ['quickbooks'] },
        ],
      },
      'setup[1].providers[0]: names quickbooks, which another connection field names',
    ],
    [
      'an optional connection no field chooses',
      {
        ...v2,
        requiredConnections: [quickBooks, { ...quickBooks, providerId: 'google' }],
        setup: [{ ...vendor, providers: ['quickbooks'] }],
      },
      "setup: optional connection 'google' is chosen by no connection field",
    ],
    [
      'a setting drawn in a step group nobody declared',
      { ...v2, setup: [{ ...vendor, group: 'filed' }, ...settings] },
      'setup[0].group: must name a declared group',
    ],
    [
      'a setting in a group without groups',
      { ...v2, groups: undefined, setup: [{ ...vendor, group: 'done' }, ...settings] },
      'setup[0].group: group is only meaningful when groups are declared',
    ],
    [
      'a choice of nothing optional',
      { ...v2, requiredConnections: [{ ...quickBooks, optional: false }] },
      'setup[0].control: is only meaningful when requiredConnections has an optional entry',
    ],
    [
      'a choice outside its section',
      { ...v2, setup: [{ ...vendor, section: 'rules' }, ...settings] },
      "setup[0].section: must be 'connections' for a connection control",
    ],
    [
      'a choice defaulting to the vendor',
      { ...v2, setup: [{ ...vendor, defaultValue: 'quickbooks' }, ...settings] },
      "setup[0].defaultValue: must be 'none' for a connection control",
    ],
    [
      'an ungrouped step',
      {
        ...v2,
        pipeline: v2.pipeline.map(({ group: _group, ...step }, i) =>
          i === 3 ? step : { ...step, group: _group },
        ),
      },
      'pipeline[3].group: every step needs a group when groups are declared',
    ],
    [
      'a group no step names',
      {
        ...v2,
        groups: [...(v2.groups ?? []), { id: 'filed', title: 'Filed', description: 'Filed.' }],
      },
      "groups[5]: group 'filed' has no step",
    ],
    [
      'a trigger outside the first group',
      {
        ...v2,
        pipeline: v2.pipeline.map((step, i) => (i === 0 ? { ...step, group: 'read' } : step)),
      },
      'pipeline[0].group: the trigger step belongs to the first group',
    ],
    [
      'a group without groups',
      { ...v2, groups: undefined },
      'pipeline[0].group: group is only meaningful when groups are declared',
    ],
  ];
  for (const [what, manifest, refusal] of cases) {
    assert.ok(
      manifestProblems(manifest).includes(refusal),
      `${what}: ${manifestProblems(manifest).join('; ')}`,
    );
  }
});
