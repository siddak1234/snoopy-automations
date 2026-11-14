/**
 * The session's proposed rule, which the owner accepted with "Yes to all 3" (2026-11-14, Round
 * 22): "A file field is required. Optional only with a written reason in the flow's spec." Each flow's NEWEST manifest in `manifests/` has
 * every `artifact` run input `required: true`, unless the flow's spec,
 * `automations/<templateId>/README.md`, gives the reason on that field's row of its run-input
 * table: the row's first cell the field's key, its last cell `no: <the reason>`. A version before
 * the newest is registered and immutable (`test/manifest-immutable.test.ts`), so it is never judged
 * again: Resume Screening v1 to v4 say `required: false`, as the platform then required.
 */

export type Json = Record<string, unknown>;

/** Of the manifest file names given, each flow's newest: `<templateId>.v<n>.json`, n the highest. */
export function newestManifests(files: readonly string[]): string[] {
  const newest = new Map<string, { file: string; version: number }>();
  for (const file of files) {
    const named = /^(?<id>.+)\.v(?<version>\d+)\.json$/u.exec(file)?.groups;
    if (named === undefined) continue;
    const version = Number(named.version);
    const kept = newest.get(named.id!);
    if (kept === undefined || version > kept.version) newest.set(named.id!, { file, version });
  }
  return [...newest.values()].map((each) => each.file).sort();
}

/** The reason a spec gives on a run input's row, `| key | … | no: <reason> |`; none without one. */
export function reasonFor(spec: string, key: string): string | undefined {
  for (const line of spec.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2 || cells[0]!.replaceAll('`', '') !== key) continue;
    const reason = /^no\s*:\s*(?<reason>\S.*)$/iu.exec(cells.at(-1)!)?.groups?.reason;
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * What the rule refuses in a flow's newest manifest, given its spec's text (undefined when the
 * flow has no spec): each optional file field with no reason, as `manifests/<file>: …`.
 */
export function optionalFileProblems(
  file: string,
  manifest: Json,
  spec: string | undefined,
): string[] {
  const trigger = (manifest.trigger ?? {}) as Json;
  if (trigger.kind !== 'manual' || !Array.isArray(trigger.input)) return [];
  return (trigger.input as Json[]).flatMap((field, index) =>
    field.control !== 'artifact' ||
    field.required === true ||
    reasonFor(spec ?? '', String(field.key)) !== undefined
      ? []
      : [
          `manifests/${file}: trigger.input[${index}] (${String(field.key)}) is a file field ` +
            `not required, with no reason: make it required, or write "no: <the reason>" in ` +
            `the Required cell of its row in automations/${String(manifest.templateId)}/README.md`,
        ],
  );
}
