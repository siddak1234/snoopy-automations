import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

/**
 * The platform's validator rules a JSON Schema cannot say, for the manifest additions of its
 * ADR-0037 (spec §1.2 and §1.4 of the Invoice Processing update): an optional connection and its
 * one `connection` setup field, and the visible step groups — ported from its
 * `packages/contracts/src/manifest-validation.ts` at the head of its PR #210
 * (`round-17/ip-update-platform`, `9516c0e`), each refusal as `<path>: <message>` in its words, so a
 * manifest that would be refused at registration fails this repository first. Every manifest in
 * `manifests/` is held to them.
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
  let choices = 0;
  for (const [index, field] of list(manifest.setup).entries()) {
    if (field.control !== 'connection') continue;
    const path = `setup[${index}]`;
    if (field.section !== 'connections') {
      add(`${path}.section`, "must be 'connections' for a connection control");
    }
    if (field.required !== false) add(`${path}.required`, 'must be false for a connection control');
    if (field.defaultValue !== 'none') {
      add(`${path}.defaultValue`, "must be 'none' for a connection control");
    }
    choices += 1;
    if (choices > 1) add(`${path}.control`, "only one setup field may have control 'connection'");
    if (optional.size === 0) {
      add(`${path}.control`, 'is only meaningful when requiredConnections has an optional entry');
    }
  }
  if (manifest.setup !== undefined && optional.size > 0 && choices === 0) {
    add('setup', "an optional connection needs one setup field with control 'connection'");
  }
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
  return problems;
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
      'two choices',
      { ...v2, setup: [vendor, { ...vendor, key: 'other' }, ...settings] },
      "setup[1].control: only one setup field may have control 'connection'",
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
