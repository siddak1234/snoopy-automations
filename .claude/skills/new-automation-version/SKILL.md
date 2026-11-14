---
name: new-automation-version
description: Use when adding a new automation, or a new manifest version of an existing one, in snoopy-automations. Walks the template or the existing folder, the manifest, prompts and tests, the gate and facts; the merge is the deploy.
---

# New automation, or a new version

Builds an automation (from `templates/automation/`) or a new version of one (in `automations/<name>/`), with its manifest, prompts and tests, green on the gate, and ends with the pull request whose merge deploys it. The rules it follows: [automations/CLAUDE.md](../../../automations/CLAUDE.md). The full procedure it shortens: [README.md](../../../README.md#build-a-flow).

## Inputs

- `<name>`: the templateId (lowercase, hyphens), and `<n>`: the version number (1 for a new automation).
- What the automation does, as steps a person would name, and the capabilities its prompts need.

## Steps

Copy [templates/checklist.md](templates/checklist.md) into your working notes and tick it as you go.

1. **Start from the right files.**
   - New automation: write `manifests/<name>.v1.json` first (step 2), then `npm run scaffold -- <name>` (`scripts/scaffold.mjs`): the folder from `templates/automation/` with `example` replaced, its lockfile and the root lock's entry, `automations/<name>/src/automation.ts` on `defineFlow`, one stub per step, one prompt stub per capability, a `test.todo` per spec §9 row and `automations/<id>/test/drill.test.ts`, beside `/create-flow`'s spec. It never overwrites a file. Then write the steps, the prompts and the tests.
   - New version: work in `automations/<name>/`. Point the Dockerfile's manifest `COPY` at `manifests/<name>.v<n>.json` alone (the container serves the manifests its image carries), and declare `SERVED_VERSIONS = [<n>]` in `automations/<name>/src/automation.ts`, adding it if absent (candidate-reviewer's shows the filter); the container serving `v<n-1>` keeps running until a release's retire pass (or the owner) retires it.
2. **Write `manifests/<name>.v<n>.json`** (a registered version is immutable: never edit an earlier file). Declare every step id the code can report, every capability its prompts use in `requiredCapabilities`, and the origin `http://<name>-v<n>.autom8x.internal:8080`. A file field is `"required": true`; optional only when the Required cell of its row in the flow's README run-input table says `no: <the reason>` (the session's proposal; the owner's "Yes to all 3", 2026-11-14; `test/file-required.test.ts` judges every flow's newest manifest). It asks nothing new of a flow on `v<n-1>` — no required connection added, no more scopes, no required setting without a `defaultValue` — unless a row of the flow's README, first cell the provider id or the setting key, ends `new in v<n>: <the reason>` (`test/no-new-requirements.test.ts`). `v<n-1>`'s file stays while it is served; it leaves `manifests/` after a release shows its `RETIRED` row (or a hand retirement is recorded), at the latest with `v<n+1>` — so the file before it, `v<n-2>`'s, leaves at the latest with this version: a flow holds at most two files (`test/definition-files.test.ts`, D3), and each removal adds its row to the flow's README "Versions", `| v<k> | retired <yyyy-mm-dd>: <where shown> |` (D5). Prompts go in `automations/<name>/prompts/`, each naming a capability, never a model; tests in `automations/<name>/test/`.
3. **Run the gate, from the repository root, holding the gate lock:**

   ```bash
   npm run facts                                      # re-emits docs/repo-facts/snoopy-automations.json
   npm run map                                        # docs/MAP.md lists the new automation or version
   git add -A && git commit                           # docs in the same commit; ends with the Co-Authored-By line
   npm run verify                                     # on the committed tree
   ```

## Stop when

- `npm run verify` fails and the fix is outside `automations/<name>/` or `manifests/`: report it, do not widen the change.
- The change needs the platform (a schema, a callback, a capability it does not offer): that is a finding, not an edit here.

## Output

- The commit on your branch and the gate's last lines. After the owner merges the pull request, the Deploy job's summary line for `<name>` v`<n>`: NEW, or UPDATE for a served version whose image changed.

## Docs to update (`docs/docs-map.json`)

- `automations/*/src/**`, `automations/*/prompts/**` and `manifests/*.v*.json` map to the flow's own `automations/<name>/README.md` (its spec): the `*` is the flow's id, so a change to one flow asks for its own README and no other.
- `.github/**`, `templates/**` and `scripts/**` map to [README.md](../../../README.md).
