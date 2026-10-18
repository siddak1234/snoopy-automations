# New automation or version: checklist

The in-repo template is the source: [templates/automation/](../../../../templates/automation/) (a copyable automation on the runner, typechecked and tested by the gate). This list never copies it.

- [ ] `<name>` and `<n>` chosen; for a new version, `manifests/<name>.v<n-1>.json` exists and stays untouched
- [ ] Files started: `templates/automation/` copied to `automations/<name>/` (new), or the Dockerfile's manifest `COPY` (and `SERVED_VERSIONS`, where declared) moved to `<n>` (new version)
- [ ] `manifests/<name>.v<n>.json`: every reportable step id declared; `requiredCapabilities` covers every prompt; origin `http://<name>-v<n>.autom8x.internal:8080`
- [ ] Prompts in `automations/<name>/prompts/` name capabilities, never models
- [ ] One idempotency key per run and step on every side effect
- [ ] Tests in `automations/<name>/test/`; `test/conformance.test.ts` green
- [ ] New automation: added to the Image and Publish matrices in `.github/workflows/ci.yml`
- [ ] `npm run facts`, `npm run map`, committed, then `npm run verify` green on the committed tree
- [ ] README.md's section for the automation updated in the same commit
- [ ] Backend finding written: `node scripts/add-automation.mjs --template-id <name> --version <n> …`, for a backend session
