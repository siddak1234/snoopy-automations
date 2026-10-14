import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isObject } from './contract.js';

/**
 * The manifest, as the runner reads it.
 *
 * Only the fields the runner needs — which steps a version declares, in order, and
 * which capabilities — and, typed for the automation that reads them, the step groups,
 * the connections and the setup fields (platform ADR-0037). The reviewed file is the platform's (its ADR-0020: a
 * manifest registers by pull request there and nowhere else); the copy in this
 * repository's `manifests/` is validated here first and rides in the image so the
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
   * 2–6, each named by at least one step, the trigger step's the first. Absent: none.
   */
  groups?: readonly ManifestStepGroup[];
  /**
   * The connections the automation calls through the platform. One marked `optional` the flow
   * may run without: the person picks it, or "none", in the manifest's one setup field whose
   * control is `connection`, and the run reads the choice from its `config` under that key.
   */
  requiredConnections?: readonly ManifestConnection[];
  /** The flow's settings, as far as an automation reads them by type. */
  setup?: readonly ManifestSetupField[];
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

/** The controls a setup field may have — `connection` the vendor choice (platform ADR-0037). */
export type SetupControl = 'toggle' | 'money' | 'text' | 'email' | 'resource-picker' | 'connection';

export interface ManifestSetupField {
  key: string;
  control: SetupControl;
  defaultValue?: unknown;
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
      `${path} is not a manifest: templateId, version, requiredCapabilities and a non-empty pipeline of step ids are required`,
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
