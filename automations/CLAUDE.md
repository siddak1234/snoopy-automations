# One automation per folder, each its own image

These rules apply here and nowhere else; the repository's are in [../CLAUDE.md](../CLAUDE.md). How an automation is built: [../README.md](../README.md#what-an-automation-looks-like).

## Rules

1. **Step ids are the manifest's.** A step is reported only under an id its `manifests/<name>.v<n>.json` declares; the runner reports, and refuses to start, any other.
2. **One idempotency key per run and step** on every side effect, so a retried step never acts twice ([../README.md](../README.md#retrying-a-step)).
3. **A prompt names a capability, never a model** ([../README.md](../README.md#model-calls)); every capability a prompt uses is in the manifest's `requiredCapabilities`.
4. **No imports across automations.** Build with the SDK and the libraries under `packages/` only; `test/isolation.test.ts` fails the build otherwise.
5. **One image per version.** Each new version gets its own container, image, origin and service account; a registered manifest is immutable, so a change is a new `v<n+1>` file ([../README.md](../README.md#adding-an-automation)).
6. **The conformance test** (`test/conformance.test.ts`) holds every automation to the manifests it serves: every step the code can report is declared. Keep it green; never loosen it.
7. **`npm run facts` after adding or removing files** (it re-emits `docs/repo-facts/snoopy-automations.json`), and `npm run map` when an automation or a manifest is added.
8. **The platform side is a finding** for a backend session: the manifest PR to its `manifests/`, the compose pin and `snoopy-backend/scripts/add-automation.mjs`. Never edit it from here.

## Commands

- `/new-automation-version`: the skill for a new automation or a new version.
- `npm run verify`, from the repository root: the whole gate.
- A new automation joins the Image and Publish matrices in [../.github/workflows/ci.yml](../.github/workflows/ci.yml), or its image is never built.
