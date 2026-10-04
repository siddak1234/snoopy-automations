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

| Round  | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10** | **OPEN 2026-09-04.** Owner-approved 2026-09-03 (§0.1); opened by its first session in plan mode per §4.1, whose approved order of attack is the round plan: scaffold (this commit) → extract the SDK → build `invoice-intake` → live observation after a backend session deploys it. The §0.1 entry is the backend's to commit. **Session 4a, 2026-09-08**: schemas re-vendored at platform `e85f903` (six findings resolved there — `runId` admitted, `retryState`/`retry` withdrawn, `http` on `.internal` admitted, price and uniqueness rules in the schema); `invoice-intake` v1, still unregistered, takes ADR-0020's origin shape `http://invoice-intake.autom8x.internal:8080` and its `notifyEmail` is relabelled as the VENDOR's address, since the platform now announces completion to the customer itself; five dependabot majors closed on the owner's decision and ignored in `dependabot.yml`, five Actions bumps merged. **Session 4b, 2026-09-09 — live observation DONE, operator-driven on the owner's decision (platform §0.1 A6; §12.1 #91–#94).** `invoice-intake` v1 was registered by the platform's 12.3.3 deploy and subscribed beside `invoice-check@2` once the owner raised the free plan's cap to 2 (platform §12.1 #92, #93). A $750 webhook invoice held at `validate`; the platform's approval mail arrived from notifications@autom8x.ai; the owner-role approval continued the run; the vendor mail went through the customer's Gmail with its subject intact (the platform's #80, the double-encoded em dash, closed by that observation); the platform's run-succeeded mail followed. Nothing in this repository changed for it. Round 10 closes in the platform repository by a fresh audit. |
| **—**  | **CI hardening, 2026-10-03 — the owner's cross-repository CI plan, Wave 1; no round open here.** `ci.yml`: every job on `ubuntu-24.04` (the `ubuntu-latest` label moves to Ubuntu 26 on 2026-10-19), and an `all-green` job (5-minute timeout) that needs Verify, Image and Publish and is red unless each succeeded — Publish's skip on a pull request, push-only by its own `if`, is the one skip allowed. The owner points the `protect-main` ruleset at `all-green` once it has reported on a pull request and on `main`. `dependabot.yml`: the root npm entry moves locks only (`versioning-strategy: lockfile-only`) and the `automations/invoice-intake` npm entry is gone — all 6 red CI runs in this repository's history were Dependabot npm pull requests that `npm ci` refused with EUSAGE (runs 36836176128, 36836170901, 33934171590, 33934107999, 33934100446, 33934094113). `manifests/invoice-intake.v2.json` added byte-identical to the platform's copy, which had been registered there without ever being validated here; `contract/schemas/automation-manifest.json` re-vendored at platform `db66611` (`contract/README.md`). The image build and the push are unchanged: publishing the scanned bytes waits on the owner's approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **—**  | **Publishing the scanned bytes, 2026-10-04 — the owner's CI plan, Wave 1 `[Au]`; no round open here.** `ci.yml` Publish (still push to `main` only, still after Verify and Image): ONE build, pushed to GHCR by digest with no tag (`push-by-digest`, `name-canonical`; the action's default provenance attestation kept, so the digest is an OCI image index's — the shape the platform pins at `deploy/compose.prod.yml` `x-intake-image`); the Image job's smoke test and both Trivy passes then run against `ghcr.io/siddak1234/autom8x-invoice-intake@sha256:…`, the pushed bytes themselves; only then does `docker buildx imagetools create` name that index `:<commit sha>`, and the step reads the tag back and fails unless it resolves to the same digest. Until this change Publish rebuilt the image Image had just checked, so the bytes in GHCR were never the bytes that had been smoke-tested or scanned (Image built locally and never pushed; Publish built again and pushed). A digest that fails its checks stays untagged, so nothing can pin it. `docker/setup-buildx-action` v4.4.1 and `docker/build-push-action` v7.4.0 at the SHAs Dependabot #20 proposes, which that pull request now duplicates. On a pull request the Image job is as before: local build, smoke, scan, no push; on `main` it still runs ahead of Publish as its gate. Proven locally first against a throwaway registry: the tag's digest equalled the pushed digest, and the registry listed no tag until `imagetools create` ran. A promotion reads the digest from the Publish log (`pushed by digest: …@sha256:…`, then `tagged: …:<sha> -> sha256:…`) or resolves the `:<sha>` tag; both are the one index digest.             |

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
   here in `manifests/`, then opened as a PR to `snoopy-backend/manifests/`. The
   platform's ADR-0020 (2026-09-08) made that the standing model: no registration
   route, because `service.origin` is where customer documents are sent and review
   is the authorization. The origin is `http://<templateId>.autom8x.internal:8080`,
   aliased on the automation's own container.
6. **`npm run verify` green before every commit** — format, build, typecheck,
   test, in that order: the SDK's emitted types are what an automation
   typechecks against, so the build comes first.
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
packages/automation-sdk/ the five callbacks, the credential-less byte fetch, the serving shell, test doubles
automations/<name>/      one automation: package.json, Dockerfile, src/, test/ (session 3 onward)
manifests/<name>.v<n>.json  the manifest as submitted to the platform; validated here
test/architecture.test.ts   the rules above, enforced
.github/workflows/ci.yml    Verify, Image, Publish (push to main only: one build pushed by digest, smoke-tested and scanned as that digest, then tagged :<sha>), and all-green: red unless every one of them succeeded
```

## Commands

```bash
npm ci --ignore-scripts   # install exactly what CI audited
npm run verify            # format:check → build → typecheck → test, root and every workspace
npm run format            # fix formatting
```
