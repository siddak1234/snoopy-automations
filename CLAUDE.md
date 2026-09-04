# snoopy-automations — read before doing anything

This repository holds **Autom8x automations**: the logic the platform dispatches a
run to, which calls back through the platform for everything it is not trusted to
hold. It is one of five independent repositories and it is **PUBLIC**, by owner
decision — an automation holds no secret by construction (platform invariant 3: a
container receives a run-scoped token at runtime and nothing else), so there is
nothing here to hide and nothing here that may ever be hidden.

## Start here, every session, no exceptions

1. `/add-dir ../snoopy-backend` — **READ ONLY.** The platform repository holds the
   governance documents that direct work across all five repositories. Reading
   them from here is required; editing them from here breaks the one-repo rule.
2. Read `snoopy-backend/docs/platform/AUTOM8X-MASTER-PLAN.md` **§0 STATUS**. It
   names the open round and the open repository. **If it does not name
   `snoopy-automations` (Round 10), you are in the wrong repo.** Say so and stop.
3. Then read, in order: MASTER-PLAN §4 (rules of engagement) and §5's Round 10
   row; SYSTEM-MANIFEST §6 (the extension points) and §12.2 #31; BUILD-PLAN
   "Deliberately not planned" → "Deferred until the first real automation".

**Verify state with commands. Never with recall.** `git log`, `npm run verify`,
and `gh api` say what is true; a document says what was true when it was written.

## Round record

| Round  | State                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10** | **OPEN 2026-09-04.** Owner-approved 2026-09-03 (§0.1); opened by its first session in plan mode per §4.1, whose approved order of attack is the round plan: scaffold (this commit) → extract the SDK → build `invoice-intake` → live observation after a backend session deploys it. The §0.1 entry is the backend's to commit. |

## Non-negotiable rules

1. **One repository per session.** Work only here. Anything that appears to need a
   change in `snoopy-backend`, `snoopy`, or `snoopy-mobile` is a **finding**: write
   it as paste-ready text in the closing message for that repository's next
   session. Never edit across repositories.
2. **No secret of any kind, ever.** Not a provider token, not an API key, not a
   database URL, not a "local only" fixture secret copied from another repository's
   compose file. This repository is public and git history is permanent.
   Secret-scanning push protection is on; it is the second line, not the first.
3. **Nothing here imports or depends on `@snoopy/*`.** The boundary is the **wire
   format** in `contract/schemas`, vendored from the platform. A third-party
   automation could have exactly that and nothing more, and the first one written
   outside that rule would discover a coupling nobody noticed.
   `test/architecture.test.ts` fails the build if it is ever violated.
4. **The SDK is the only outbound path.** `packages/automation-sdk` presents the
   run token and nothing else, on every callback. An automation that reaches
   anything by another route is where a credential eventually leaks.
5. **Manifests land in the platform by pull request** — authored and validated
   here in `manifests/`, then opened as a PR to `snoopy-backend/manifests/` — until
   the registration route of SYSTEM-MANIFEST §12.2 #31 exists. `service.origin` is
   where customer documents are sent; its write path is review.
6. **`npm run verify` green before every commit** — format, typecheck, test, and
   build once a workspace exists (npm refuses `--workspaces` over none; the
   fan-out arrives with the first package).
   Run `/code-review` on the diff before committing, and `/security-review` on
   anything touching the run token, the callbacks, or mail construction.
7. **Every change after the scaffold goes PR → CI → squash-merge.** `main` is
   protected by the `protect-main` ruleset; CI runs on GITHUB_TOKEN alone.
8. **Standing constraints:** ~400-line ceiling on source files (tested); no
   speculative abstractions; zero runtime dependencies unless a concrete automation
   demands one, and then audited; a step is reported only under an id the manifest
   declares; a summary never carries the document it describes.
9. **No new documents.** The documents of record here are `CLAUDE.md`,
   `README.md`, and the directory READMEs under `contract/` and `automations/`.
   Decisions belong in the platform's ADRs; discrepancies in its manifest §12 —
   both reached through a backend session, as findings.

## Layout

```
contract/schemas/        the wire contract, vendored byte-for-byte (contract/README.md)
packages/automation-sdk/ the five callbacks + the serving shell + test doubles (Round 10, session 2)
automations/<name>/      one automation: package.json, Dockerfile, src/, test/ (session 3 onward)
manifests/<name>.v<n>.json  the manifest as submitted to the platform; validated here
test/architecture.test.ts   the rules above, enforced
.github/workflows/ci.yml    Verify (and, once an image exists, Image and Publish)
```

## Commands

```bash
npm ci --ignore-scripts   # install exactly what CI audited
npm run verify            # format:check → typecheck → test (→ build, from the first workspace on)
npm run format            # fix formatting
```
