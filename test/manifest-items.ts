/**
 * The platform's validator rules for a flow's `items` that a JSON Schema cannot say (its
 * ADR-0046, Round 19), ported from its
 * `snoopy-backend/packages/contracts/src/manifest-validation.ts` (`validateItems`, and
 * `heldSchemaProblem` in its `items.ts`) at `2d93d99`, each refusal as
 * `<path>: <message>` in its words. `test/manifest-rules.ts` adds them to every manifest's.
 * What the schema already refuses — an unknown key, a length, a count, an option twice — is
 * left to the schema, which `test/architecture.test.ts` holds every manifest to.
 */

type Json = Record<string, unknown>;
type Add = (path: string, message: string) => void;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The keywords the platform holds an output to, and the annotations it reads past (its `items.ts`). */
const HELD = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'nullable',
  'anyOf',
  'oneOf',
  'allOf',
]);
const ANNOTATIONS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'example',
  'format',
  'propertyOrdering',
  '$schema',
  '$id',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
]);
const DEPTH = 32;

/** Where a schema uses what the platform cannot hold an output to, as `[path, message]`. */
export function heldSchemaProblem(
  schema: unknown,
  at: string,
  depth = 0,
): [string, string] | undefined {
  if (depth > DEPTH) return [at, `nests deeper than ${DEPTH} levels`];
  if (!isRecord(schema)) return [at, 'must be a schema object'];
  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    if (!HELD.has(keyword))
      return [at, `uses ${keyword}, which the platform cannot hold an output to`];
    if (keyword === 'properties' && !isRecord(value))
      return [`${at}.properties`, 'must be an object'];
    const subschemas: [unknown, string][] =
      keyword === 'properties' && isRecord(value)
        ? Object.entries(value).map(([name, sub]) => [sub, `${at}.properties.${name}`])
        : keyword === 'items' || (keyword === 'additionalProperties' && typeof value !== 'boolean')
          ? [[value, `${at}.${keyword}`]]
          : ['anyOf', 'oneOf', 'allOf'].includes(keyword) && Array.isArray(value)
            ? value.map((sub, index): [unknown, string] => [sub, `${at}.${keyword}[${index}]`])
            : [];
    for (const [sub, path] of subschemas) {
      const problem = heldSchemaProblem(sub, path, depth + 1);
      if (problem) return problem;
    }
  }
  return undefined;
}

/** One field's rules: a select's options and default, each property only on its own control. */
function fieldProblems(field: Json, path: string, add: Add): void {
  for (const name of ['options', 'allowOther', 'defaultValue']) {
    if (field.control !== 'select' && field[name] !== undefined) {
      add(`${path}.${name}`, "is only meaningful on a 'select' field");
    }
  }
  if (field.control !== 'text' && field.maxLength !== undefined) {
    add(`${path}.maxLength`, "is only meaningful on a 'text' field");
  }
  if (field.control !== 'select') return;
  if (list(field.options).length === 0) add(`${path}.options`, 'must declare at least 1 option');
  if (field.defaultValue !== undefined && !list(field.options).includes(field.defaultValue)) {
    add(`${path}.defaultValue`, 'must be one of options');
  }
}

/** Every refusal of the platform's `validateItems` the schema cannot say; none without `items`. */
export function itemsProblems(manifest: Json, add: Add): void {
  const items = manifest.items;
  if (!isRecord(items)) return;
  const trigger = isRecord(manifest.trigger) ? manifest.trigger : {};
  if (trigger.kind !== 'manual') {
    add('items', "needs trigger.kind 'manual': a person makes an item and starts its runs");
  }
  if (manifest.artifacts === undefined) {
    add('items', 'needs an artifacts block: an item is made from a file');
  }
  const byKey = new Map<unknown, Json>();
  list(items.fields).forEach((field, index) => {
    if (!isRecord(field)) return;
    const path = `items.fields[${index}]`;
    fieldProblems(field, path, add);
    if (byKey.has(field.key)) add(`${path}.key`, 'is declared more than once');
    else byKey.set(field.key, field);
  });
  const title = byKey.get(items.titleField);
  if (title === undefined) add('items.titleField', 'must name a field of items.fields');
  else if (title.required !== true) {
    add('items.titleField', 'must name a required field: its value names the item');
  }
  if (items.groupField !== undefined && byKey.get(items.groupField)?.control !== 'select') {
    add('items.groupField', "must name a 'select' field of items.fields");
  }
  const fileKey = isRecord(items.file) ? items.file.key : undefined;
  if (fileKey !== undefined && byKey.has(fileKey)) {
    add('items.file.key', 'must not be a key of items.fields');
  }
  if (list(trigger.input).some((field) => isRecord(field) && field.key === fileKey)) {
    add('items.file.key', 'must not be a key of trigger.input');
  }
  const runSteps = new Set(
    list(manifest.pipeline).map((step) => (isRecord(step) ? step.id : undefined)),
  );
  const seen = new Set<unknown>();
  list(items.pipeline).forEach((step, index) => {
    if (!isRecord(step)) return;
    const path = `items.pipeline[${index}].id`;
    if (seen.has(step.id)) add(path, 'is declared more than once');
    else if (runSteps.has(step.id)) {
      add(path, 'is a pipeline step id: an item run reports its own steps');
    }
    seen.add(step.id);
  });
  const held = heldSchemaProblem(items.outputSchema, 'items.outputSchema');
  if (held) add(held[0], held[1]);
}
