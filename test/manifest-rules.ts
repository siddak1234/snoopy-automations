/**
 * The platform's validator rules a JSON Schema cannot say, for the manifest additions of its
 * ADR-0037 (spec §1.2 and §1.4 of the Invoice Processing update), its ADR-0040 (Build 21, C4:
 * one connection per step) and its ADR-0041 (Build 22: a step that is a setting, the platform's
 * email step, a step's title by the flow's connection): an optional connection and the connection
 * setup fields that choose it, a setup field's step group, and the visible step groups — ported
 * from its `packages/contracts/src/manifest-validation.ts` (PR #210's `9516c0e`, then the Build 21
 * branch `round-17/b21-platform`; Build 22's rules from the session's spec of 2026-10-17, §2
 * "Manifest", in its words, built beside the platform's `round-17/b22-platform`), each refusal as
 * `<path>: <message>`, so a manifest that would be refused at registration fails this repository
 * first. Every manifest in `manifests/` is held to them.
 */

export type Json = Record<string, unknown>;
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
  // §1.4 — the visible step groups; ADR-0041 — the platform's step, the last.
  let declared: string[] | undefined;
  const platforms = new Set<string>();
  if (manifest.groups !== undefined) {
    const groups = list(manifest.groups);
    if (groups.length < 2) add('groups', 'must declare at least 2 groups');
    if (groups.length > 6) add('groups', 'must hold at most 6 items');
    declared = [];
    for (const [index, group] of groups.entries()) {
      const id = String(group.id);
      if (declared.includes(id)) add(`groups[${index}].id`, 'is declared more than once');
      declared.push(id);
      if (group.platform === undefined) continue;
      const path = `groups[${index}].platform`;
      if (group.platform !== 'email') add(path, 'must be email');
      if (platforms.size > 0) add(path, "only one group may be the platform's");
      if (index !== groups.length - 1) add(path, "the platform's step is the last group");
      platforms.add(id);
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
    } else if (platforms.has(step.group)) {
      add(path, "no pipeline step may be in the platform's step");
    } else if (index === 0 && step.group !== declared[0]) {
      add(path, 'the trigger step belongs to the first group');
    }
  }
  // ADR-0040 — a setting may say which step it is drawn in; ADR-0041 — never the platform's.
  for (const [index, field] of list(manifest.setup).entries()) {
    if (field.group === undefined) continue;
    const path = `setup[${index}].group`;
    if (declared === undefined) add(path, 'group is only meaningful when groups are declared');
    else if (typeof field.group !== 'string' || !declared.includes(field.group)) {
      add(path, 'must name a declared group');
    } else if (platforms.has(field.group)) add(path, "no setting may be in the platform's step");
  }
  // ADR-0041 — a group no step names is a step that is a setting, or the platform's.
  for (const [index, id] of (declared ?? []).entries()) {
    if (platforms.has(id)) continue;
    const named = (entries: readonly Json[]) => entries.some((each) => each.group === id);
    if (!named(pipeline) && !named(list(manifest.setup))) {
      add(`groups[${index}]`, `group '${id}' has no step and no setting`);
    }
  }
  titlesByConnection(list(manifest.groups), list(manifest.setup), optional, add);
  return problems;
}

type Add = (path: string, message: string) => void;

/**
 * ADR-0041 — a step's title by the flow's connection: its `field` a connection setup field, each
 * title for a provider that field chooses among (its `providers`, or every optional connection for
 * a manifest's one field naming none), each provider once. The counts and lengths are the schema's.
 */
function titlesByConnection(
  groups: readonly Json[],
  setup: readonly Json[],
  optional: ReadonlySet<unknown>,
  add: Add,
): void {
  for (const [index, group] of groups.entries()) {
    if (group.titleByConnection === undefined) continue;
    const path = `groups[${index}].titleByConnection`;
    const titled = group.titleByConnection as Json;
    const field = setup.find((each) => each.key === titled.field && each.control === 'connection');
    if (field === undefined) add(`${path}.field`, 'must name a connection field');
    const chooses: unknown[] = Array.isArray(field?.providers)
      ? (field.providers as unknown[])
      : [...optional];
    const seen: unknown[] = [];
    for (const [at, title] of list(titled.titles).entries()) {
      const where = `${path}.titles[${at}].providerId`;
      if (field !== undefined && !chooses.includes(title.providerId)) {
        add(where, "must be one of that field's providers");
      } else if (seen.includes(title.providerId)) add(where, 'is declared more than once');
      seen.push(title.providerId);
    }
  }
}

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
