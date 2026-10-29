import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isObject, type JsonObject } from './contract.js';

/**
 * The manifest, as the runner reads it.
 *
 * Only the fields the runner needs — which steps a version declares, in order, and
 * which capabilities — and, typed for the automation that reads them, the step groups,
 * the connections and the setup fields (platform ADR-0037). The reviewed file is the copy in this
 * repository's `manifests/`, merged here: the platform's Flow CD validates and registers it
 * from the merge commit (its ADR-0047). It is validated here first and rides in the image so the
 * runner can refuse BEFORE the wire what the platform would refuse after it. A
 * copy that drifts from the registered one is told, not humoured: the platform
 * refuses a step or a capability the registered version does not declare.
 */
export interface Manifest {
  templateId: string;
  version: number;
  requiredCapabilities: readonly string[];
  /** Each step, and the visible group it is shown under when the manifest declares groups. */
  pipeline: readonly ManifestStep[];
  /**
   * The visible step groups a person sees a run's progress in, in order (platform ADR-0037):
   * 2–6, the trigger step's the first; each named by at least one step, or by a setting (a step
   * that is a choice), or the platform's own last step (`platform`, ADR-0041). Absent: none. Typed
   * here as far as an automation reads them: a group's `titleByConnection` and `platform` are for
   * the clients and the platform, and are validated by the published schema.
   */
  groups?: readonly ManifestStepGroup[];
  /**
   * The connections the automation calls through the platform. One marked `optional` the flow
   * may run without: the person picks it, or "none", in a setup field whose control is
   * `connection` — the one that names it in `providers`, or the manifest's one such field — and
   * the run reads the choice from its `config` under that field's key.
   */
  requiredConnections?: readonly ManifestConnection[];
  /** The flow's settings, as far as an automation reads them by type. */
  setup?: readonly ManifestSetupField[];
  /**
   * The flow's items (platform ADR-0046): things a person makes once, from a file, that its runs
   * then belong to. Typed as far as an automation reads them; the words, fields and reading's
   * schema are for the platform and the clients, and are validated by the published schema.
   */
  items?: ManifestItems;
  /** What a flow shows, as far as an automation reads it: the order of its pages' parts. */
  display?: { pages?: ManifestPages };
}

/**
 * The parts of each page a manifest's `display.pages` may order (platform ADR-0048 decision 5):
 * a closed set, the schema's `enum`s. Each part on its own page and used once; a run page holds
 * `outcome` and `result`, an item page `add` and `runs`; item parts need `items`, and `tiles`
 * `items.verdictWords` (the rules beyond the schema: `contract/README.md`). `scores`, the item's
 * runs by score as a bar chart (amendment 1, point 3b), is opt-in: a page left out, drawn in
 * today's order, never gets it. Inside `result`, the blocks keep the order the automation sent them.
 */
export const PAGE_PARTS = {
  flow: ['dashboard', 'steps', 'items'],
  item: ['tiles', 'file', 'add', 'runs', 'scores'],
  run: ['files', 'outcome', 'result'],
  file: ['viewer', 'reading'],
} as const;

/** A manifest's `display.pages`: for each page it orders, its parts in order. */
export type ManifestPages = {
  readonly [Page in keyof typeof PAGE_PARTS]?: readonly (typeof PAGE_PARTS)[Page][number][];
};

/**
 * A flow's items as the runner reads them: the item run's own steps — the run that reads a new
 * item's file (`readsItem`) reports these, and only these — and the key its file arrives under in
 * that run's `input`.
 */
export interface ManifestItems {
  file: { key: string };
  pipeline: readonly { id: string }[];
}

/** One pipeline step: its id, and its group when the manifest declares groups. */
export interface ManifestStep {
  id: string;
  group?: string;
}

/** A visible step group (platform ADR-0037): `title` at most 40 characters, `description` 120. */
export interface ManifestStepGroup {
  id: string;
  title: string;
  description: string;
}

export interface ManifestConnection {
  providerId: string;
  /** True: the flow may run without it. Absent is false: required, as before. */
  optional?: boolean;
}

/**
 * The controls a setup field may have — `connection` the vendor choice (platform ADR-0037), and
 * `select` a dropdown of `options`, one or (`multiple`) several picked (the platform round for
 * ICD-10 Code Check, F1, 2026-10-28).
 */
export type SetupControl =
  'toggle' | 'money' | 'text' | 'email' | 'resource-picker' | 'connection' | 'select';

export interface ManifestSetupField {
  key: string;
  control: SetupControl;
  defaultValue?: unknown;
  /**
   * A `connection` field's providers: the optional connections it chooses among (platform
   * ADR-0040, one connection field per step that uses one). Absent on a manifest's one connection
   * field: every optional connection.
   */
  providers?: readonly string[];
  /** The step group the field is drawn in (platform ADR-0040), by its id. */
  group?: string;
  /** A `select` field's choices, 1 to 32, each 1 to 80 characters. */
  options?: readonly string[];
  /** A `select` field that picks several: its value is a list. Absent is false: one string. */
  multiple?: boolean;
}

/**
 * A `select` field's picks, from a run's `config`: a string or a list of strings, as the platform
 * saved it, kept only where it is one of the field's options, each once, in the options' order;
 * nothing saved, the field's default, read the same way. A value of any other shape picks none.
 */
export function chosenOptions(config: JsonObject, field: ManifestSetupField): string[] {
  const options = field.options ?? [];
  const read = (value: unknown): string[] | undefined =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((one) => typeof one === 'string')
        ? (value as string[])
        : undefined;
  const picked = read(config[field.key]) ?? read(field.defaultValue) ?? [];
  return options.filter((option) => picked.includes(option));
}

/**
 * The value of a flow's vendor choice that chooses no connection: a manifest's one `connection`
 * setup field defaults to it, and the platform stores it when the person picks "None"
 * (platform ADR-0037).
 */
export const CONNECTION_NONE = 'none' as const;

/** `<templateId>.v<n>.json`, the one filename the platform registers. */
const MANIFEST_FILE = /^([a-z][a-z0-9-]*[a-z0-9])\.v([0-9]+)\.json$/u;

export function isManifest(value: unknown): value is Manifest {
  if (!isObject(value)) return false;
  return (
    typeof value.templateId === 'string' &&
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version >= 1 &&
    Array.isArray(value.requiredCapabilities) &&
    value.requiredCapabilities.every((capability) => typeof capability === 'string') &&
    Array.isArray(value.pipeline) &&
    value.pipeline.length > 0 &&
    value.pipeline.every((step) => isObject(step) && typeof step.id === 'string') &&
    (value.items === undefined || isManifestItems(value.items))
  );
}

/** An `items` block the runner can run: its file's key, and a non-empty pipeline of step ids. */
function isManifestItems(value: unknown): value is ManifestItems {
  return (
    isObject(value) &&
    isObject(value.file) &&
    typeof value.file.key === 'string' &&
    Array.isArray(value.pipeline) &&
    value.pipeline.length > 0 &&
    value.pipeline.every((step) => isObject(step) && typeof step.id === 'string')
  );
}

/** One manifest file. An error names the path and never the content. */
export function readManifest(path: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not a JSON file`);
  }
  if (!isManifest(parsed)) {
    throw new Error(
      `${path} is not a manifest: templateId, version, requiredCapabilities and a non-empty pipeline of step ids are required, and items, when declared, a file key and a non-empty pipeline of step ids`,
    );
  }
  return parsed;
}

/**
 * Every version of one template in a directory — `<templateId>.v<n>.json`, read
 * in version order. These are the versions the container SERVES: a run pinned to
 * any other version is failed by the runner rather than guessed at.
 *
 * Throws when the directory holds none, because a container that serves no
 * version would answer the liveness probe and fail every run it accepted.
 */
export function readManifests(directory: string, templateId: string): Manifest[] {
  const manifests = readdirSync(directory)
    .filter((file) => MANIFEST_FILE.exec(file)?.[1] === templateId)
    .map((file) => readManifest(join(directory, file)))
    .sort((a, b) => a.version - b.version);
  if (manifests.length === 0) {
    throw new Error(`${directory} holds no ${templateId}.v<n>.json manifest`);
  }
  for (const manifest of manifests) {
    if (manifest.templateId !== templateId) {
      throw new Error(
        `${directory} holds a ${templateId} manifest file that declares templateId ${manifest.templateId}`,
      );
    }
  }
  return manifests;
}
