---
name: new-automation-version
description: Use when adding a new automation, or a new manifest version of an existing one, in snoopy-automations. Walks the template or the existing folder, the manifest, prompts and tests, the gate and facts; the merge is the deploy.
---

# New automation, or a new version

Builds an automation (from `templates/automation/`) or a new version of one (in `automations/<name>/`), with its manifest, prompts and tests, green on the gate, and ends with the pull request whose merge deploys it. The rules it follows: [automations/CLAUDE.md](../../../automations/CLAUDE.md). The full procedure it shortens: [README.md](../../../README.md#adding-an-automation).

## Inputs

- `<name>`: the templateId (lowercase, hyphens), and `<n>`: the version number (1 for a new automation).
- What the automation does, as steps a person would name, and the capabilities its prompts need.

## Steps

Copy [templates/checklist.md](templates/checklist.md) into your working notes and tick it as you go.

1. **Start from the right files.**
   - New automation: `mkdir -p automations/<name> && cp -R templates/automation/. automations/<name>/` (beside `/create-flow`'s spec, when there is one), then replace `example` with `<name>` everywhere (`package.json`, `Dockerfile`, `src/`), and give it a lockfile as README's step 1 says.
   - New version: work in `automations/<name>/`. Point the Dockerfile's manifest `COPY` at `manifests/<name>.v<n>.json` alone (the container serves the manifests its image carries), and where `automations/<name>/src/automation.ts` declares `SERVED_VERSIONS` (invoice-processing's does), set it to `[<n>]`; the container serving `v<n-1>` keeps running until the owner retires it.
2. **Write `manifests/<name>.v<n>.json`** (a registered version is immutable: never edit an earlier file). Declare every step id the code can report, every capability its prompts use in `requiredCapabilities`, and the origin `http://<name>-v<n>.autom8x.internal:8080`. Prompts go in `automations/<name>/prompts/`, each naming a capability, never a model; tests in `automations/<name>/test/`.
3. **Run the gate, from the repository root, holding the gate lock:**

   ```bash
   npm install --package-lock-only --ignore-scripts   # a new automation only: the root lock learns the workspace
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

- `automations/*/src/**` and `automations/*/prompts/**` map to [README.md](../../../README.md): update the automation's section there (for example "Invoice processing").
- `manifests/**` maps to README.md as well; `.github/**` too.
