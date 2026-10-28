# New automation or version: checklist

The in-repo template is the source: [templates/automation/](../../../../templates/automation/) (a worked flow on `defineFlow`, typechecked and tested by the gate, which `npm run scaffold` builds a new flow's frame from). This list never copies it.

- [ ] `<name>` and `<n>` chosen; for a new version, `manifests/<name>.v<n-1>.json` exists and stays untouched
- [ ] Files started: `npm run scaffold -- <name>` after the manifest (new), or the Dockerfile's manifest `COPY` moved to `<n>` and `SERVED_VERSIONS = [<n>]` declared, added if absent (new version)
- [ ] `manifests/<name>.v<n>.json`: every reportable step id declared; `requiredCapabilities` covers every prompt; origin `http://<name>-v<n>.autom8x.internal:8080`
- [ ] Prompts in `automations/<name>/prompts/` name capabilities, never models
- [ ] One idempotency key per run and step on every side effect
- [ ] Tests in `automations/<name>/test/`, one per spec §9 row, and `automations/<id>/test/drill.test.ts` (the failure drill); `test/conformance.test.ts` green
- [ ] `npm run facts`, `npm run map`, committed, then `npm run verify` green on the committed tree
- [ ] The flow's own `automations/<name>/README.md` updated in the same commit
- [ ] After the merge: the Deploy job's summary shows `<name>` v`<n>` NEW (or UPDATE)
