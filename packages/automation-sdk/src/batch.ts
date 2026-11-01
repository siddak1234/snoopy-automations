import { line } from './blocks-limits.js';
import { isObject, type JsonObject } from './contract.js';
import { ARTIFACT_ID_PATTERN } from './model-request.js';

/**
 * Batch intake (platform ADR-0048 amendment 4, P1 to P3), copied from the published schemas
 * (`contract/schemas`) and the platform's words, never imported: a model request may read a page
 * range of a PDF (`pages`); a manifest may declare `batch`, which makes its manual run a BATCH RUN
 * that runs `batch.pipeline` and may answer `units`; the platform then queues one CHILD RUN per
 * unit, whose invoke carries `unit` and runs the manifest's `pipeline`.
 */

/** The platform's bounds (the menu's `limits.batch`). */
export const BATCH_LIMITS = {
  units: 500,
  unitLabelLength: 120,
  unitArtifacts: 50,
  unitDataBytes: 8_192,
  /** Pages one model request may read of a PDF. */
  pages: 20,
} as const;

/** Pages of a PDF: 1-based, inclusive, `from ≤ to`, at most `BATCH_LIMITS.pages`. */
export interface PageRange {
  from: number;
  to: number;
}

/** One file of a unit: one of the batch run's files, and optionally a page range of it. */
export interface UnitArtifact {
  artifactId: string;
  pages?: PageRange;
}

/** One unit a batch run answers: what its child run is given. */
export interface BatchUnit {
  /** 1 to 120 characters, one line: what the batch part lists the child as. */
  label: string;
  /** 1 to 50 of the batch run's files. */
  artifacts: readonly UnitArtifact[];
  /** A JSON object of at most 8 KiB, for the child. */
  data: JsonObject;
}

/** A child run's unit, as its invoke carries it: its batch run, its place (0-based) and the unit. */
export interface InvokeUnit extends BatchUnit {
  parentRunId: string;
  index: number;
}

/** A manifest's `batch`, as the runner reads it: the batch run's own steps. */
export interface ManifestBatch {
  pipeline: readonly { id: string }[];
  unitWords: { singular: string; plural: string };
}

/** Why `value` is not a page range, in the platform's words; undefined when it is one. */
export function pageRangeProblem(value: unknown, at = 'pages'): string | undefined {
  if (!isObject(value)) return `${at} must be an object with from and to`;
  for (const key of Object.keys(value)) {
    if (key !== 'from' && key !== 'to') return `${at}.${key} is not a page range property`;
  }
  for (const name of ['from', 'to'] as const) {
    const page = value[name];
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      return `${at}.${name} must be a whole number of at least 1`;
    }
  }
  const from = value.from as number;
  const to = value.to as number;
  if (from > to) return `${at}.from must not be after ${at}.to`;
  if (to - from + 1 > BATCH_LIMITS.pages)
    return `${at} must name at most ${BATCH_LIMITS.pages} pages`;
  return undefined;
}

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const utf8Bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Why a batch run's `units` is not what the platform takes, in its words (`batchUnitsProblem`
 * there): 1 to 500 units of `{label, artifacts, data}`, a label of 1 to 120 characters on one line,
 * 1 to 50 files each an upload id with an optional page range, the same file and range never twice
 * in a unit, and a JSON object of at most 8 KiB. Whether each file is the batch run's own is the
 * platform's, which reads them.
 */
export function batchUnitsProblem(units: readonly BatchUnit[]): string | undefined {
  if (units.length < 1 || units.length > BATCH_LIMITS.units) {
    return `units must list 1 to ${BATCH_LIMITS.units} units`;
  }
  for (const [index, unit] of units.entries()) {
    const at = `units[${index}]`;
    const { label, artifacts, data } = unit;
    if (
      typeof label !== 'string' ||
      label.trim() === '' ||
      [...label].length > BATCH_LIMITS.unitLabelLength ||
      LINE_BREAK.test(label)
    ) {
      return `${at}.label must be 1 to ${BATCH_LIMITS.unitLabelLength} characters on one line`;
    }
    if (artifacts.length < 1 || artifacts.length > BATCH_LIMITS.unitArtifacts) {
      return `${at}.artifacts must list 1 to ${BATCH_LIMITS.unitArtifacts} files`;
    }
    const named = new Set<string>();
    for (const [position, artifact] of artifacts.entries()) {
      const where = `${at}.artifacts[${position}]`;
      if (!ARTIFACT_ID_PATTERN.test(artifact.artifactId)) {
        return `${where}.artifactId must be the id of an uploaded file`;
      }
      const key = `${artifact.artifactId.toLowerCase()}:${JSON.stringify(artifact.pages ?? null)}`;
      if (named.has(key)) return `${where} names a file twice`;
      named.add(key);
      const problem =
        artifact.pages === undefined
          ? undefined
          : pageRangeProblem(artifact.pages, `${where}.pages`);
      if (problem) return problem;
    }
    if (!isObject(data)) return `${at}.data must be an object`;
    if (utf8Bytes(data) > BATCH_LIMITS.unitDataBytes) {
      return `${at}.data must be at most ${BATCH_LIMITS.unitDataBytes} bytes as JSON`;
    }
  }
  return undefined;
}

/**
 * A batch run's units as the platform takes them: none sent when none are given; each label one
 * plain line, cut whole at its bound. Anything else the platform would refuse is refused here,
 * before anything is sent, in its words: dropping or changing a unit would queue a different batch.
 */
export function boundedUnits(units: readonly BatchUnit[] | undefined): BatchUnit[] | undefined {
  if (units === undefined) return undefined;
  const shaped = units.map((unit) => ({
    ...unit,
    label: line(unit.label, BATCH_LIMITS.unitLabelLength) ?? '',
  }));
  const problem = batchUnitsProblem(shaped);
  if (problem) throw new Error(problem);
  return shaped;
}

/** Whether an invoke's `unit` is one the platform could have sent. */
export function isInvokeUnit(value: unknown): value is InvokeUnit {
  return (
    isObject(value) &&
    typeof value.parentRunId === 'string' &&
    Number.isInteger(value.index) &&
    typeof value.label === 'string' &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(
      (artifact: unknown) => isObject(artifact) && typeof artifact.artifactId === 'string',
    ) &&
    isObject(value.data)
  );
}
