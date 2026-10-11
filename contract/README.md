# The wire contract, vendored

`schemas/` is a byte-for-byte copy of the platform repository's `schemas/` directory
(`snoopy-backend`, private) at commit `7086e5e`, re-pinned 2026-10-11 — the platform's
`main` after its #197 — but for one file taken from a branch not yet merged,
`automation-model-request.json`, which the last refresh note below names. The platform emits
them with `npm run schemas:emit` and verifies the committed files against its TypeScript
types byte for byte, so this copy is the contract it publishes to external automation
authors. To refresh: copy the directory again and update the commit above in the same
change.

They are copied rather than fetched because a public repository's CI cannot read a
private one, and copied rather than imported because the boundary is the **wire
format, not a package** — an automation written anywhere else would have exactly
this and nothing more.

## What changed at this pin

Session 2 and 3 here filed six disagreements between the published schemas and the
platform's runtime; the platform resolved them in its Round 10 sessions B2 through A2,
and this copy carries the result:

- `automation-step-report.json` **requires** `runId`, which the platform's handler
  always required and this SDK always sent.
- `automation-run-result.json` admits `runId` on every branch; the platform binds it to
  the run token when sent.
- `retryState` and `continuation.kind: 'retry'` are **withdrawn** (platform §12.1 #84):
  nothing ever read them. A failed run is re-run as a fresh run.
- `automation-manifest.json` admits `http` on a non-routable host — `localhost`,
  `127.0.0.1`, `::1`, `*.internal`, `*.localhost` — exactly as the validator always did
  (platform §12.1 #83). `invoice-intake` now declares
  `http://invoice-intake.autom8x.internal:8080`, the shape the platform's ADR-0020
  chose for every automation: the container carries the name as a network alias, so it
  is reachable only on the compose network by construction.
- `pricing.monthlyPriceUsd` carries `multipleOf: 0.01`; `requiredConnections` and
  `requiredCapabilities` carry `uniqueItems` (platform §12.1 #86).

Refreshed 2026-10-03 at `db66611` (the deployed `a82c870` carries the same bytes): since
`e85f903` only `automation-manifest.json` had moved, additively — `trigger.input[]`, up to
16 fields a trigger may collect (platform `280b06a`), and `email` among the setup controls
(platform `d866aa0`). The other six files are byte-identical to the previous pin.

Refreshed 2026-10-08 at `867d0ee` (Round 16's close; the platform's `main` at Round 17's
open, `949dc8d`, carries the same blobs): **all seven files are byte-identical to
`db66611`** — nothing moved. What did change is what the platform SERVES without emitting:
the sixth callback, `POST /v1/automations/callbacks/mail` (its ADR-0021: the platform is
the only sender). Its `AutomationMailRequest` is exported from the platform's contracts
package and `docs/openapi.yaml`'s callback enum names `mail`, but `schemas/` carries no
`automation-mail-request.json`, and the split `docs/openapi/automations.yaml` still
names five messages. So the SDK's `MailRequest` is copied from the handler's allow-list —
`to`, `subject`, `body`, `idempotencyKey` (`runId` optional there and never sent) — and
`packages/automation-sdk/test/contract.test.ts` holds it to that list by name. It is the
one message here with no vendored schema to validate against; filed for the platform as a
finding with this refresh.

Refreshed 2026-10-09 at `e0d58d4`: **eight files**. `automation-mail-request.json` arrived — the
platform emits it since `ccc10e4` (#179, its BUILD-PLAN 25.3.7), and its split
`docs/openapi/automations.yaml` names `mail` among the callbacks — so the finding above is
answered, and `packages/automation-sdk/test/contract.test.ts` validates `MailRequest` against the
schema as it does every other message. The other seven files are byte-identical to `867d0ee`'s.

Refreshed 2026-10-09, later, at `dcb8ddb` — the head of the platform's branch
`round-17/openrouter-v2`, not yet merged — for its BUILD-PLAN 25.2.16:
`automation-model-request.json` gains the optional `models`, one to three distinct model
ids (the primary, then its fallbacks), each held to the platform's one model-id rule as a
`pattern`. The other seven files are byte-identical to `e0d58d4`'s (each checked with
`cmp`). Taken from the branch because this repository's half of 25.2.16 — `ModelRequest.models`
and `packages/automation-sdk/src/model-request.ts`, held to this file by
`packages/automation-sdk/test/contract.test.ts` — is built beside the platform's, and the
platform's `main` and its live deployment answer `models` with a 400 until that pull
request merges and is promoted. When it lands (squash-merged, so under another commit),
this copy is refreshed to the merge commit, its bytes unchanged unless the review changed
them.

Refreshed 2026-10-09, later still, at `94794c7` — the same branch after its pull request's
second review, which changed them: `automation-model-request.json`'s `pattern` now holds a
model id to OpenRouter's lowercase set and refuses OpenRouter's own `openrouter/…` routers.
The other seven files are byte-identical to `dcb8ddb`'s (each checked with `cmp`). The note
above still holds: re-pinned to the merge commit when it lands.

Re-pinned 2026-10-09 at `1e5ab5b`, the platform's `main` after #190 squash-merged that branch:
its tree is `94794c7`'s (`c2e0713`), so all eight files are byte-identical (each checked with
`cmp` against `1e5ab5b`) and only the commit above moves.

Refreshed 2026-10-09, later still, at `49c9fac` — the platform's `main` after its #193 (its
BUILD-PLAN 25.2.17, 25.2.19 and 25.2.20): `automation-model-request.json`'s `pattern` now also
refuses OpenRouter's `:nitro` and `:floor` variants, the owner's cost guard. The other seven
files are byte-identical to `1e5ab5b`'s (each checked with `cmp` against `49c9fac`).

Refreshed 2026-10-10 at `1137ac9` — the head of the platform's branch
`round-17/model-path-invoice` (its #195, which carries #194), not yet merged — for its
BUILD-PLAN 25.2.21 and 25.2.18. `automation-manifest.json` gains the optional `artifacts`
block the platform's validator has always read (1–32 media types, each held to its
`MEDIA_TYPE_PATTERN`, and `maximumSizeBytes` from 1 to 100 MiB): until it, the schema closed
the manifest without it, so a manifest declaring its files failed this copy.
`automation-model-request.json` gains the optional `artifactId`, the run's file the model
reads, held to the platform's `ARTIFACT_ID_PATTERN`. The other six files are byte-identical
to `49c9fac`'s (each checked with `cmp` against `1137ac9`). Taken from the branch for the
same reason as `dcb8ddb` above: this repository's half — `ModelRequest.artifactId` and
`artifactIdProblem` in `packages/automation-sdk/src/model-request.ts`, held to this file by
`packages/automation-sdk/test/contract-model-request.test.ts` — is built beside the platform's, which
answers `artifactId` with a 400 until that pull request merges and is promoted. Re-pinned
to the merge commit when it lands.

Re-pinned 2026-10-10 at `4875579`, the platform's `main` after #195 squash-merged that branch:
its tree is `1137ac9`'s (`00713ed`), so all eight files are byte-identical (each checked with
`cmp` against `4875579`) and only the commit above moves. The platform serves `artifactId` once
a promotion carries `4875579`; until then its live deployment answers it with a 400.

Refreshed 2026-10-10, later, from two of the platform's branches, neither yet merged — as
`dcb8ddb` and `1137ac9` were above, this repository's half built beside the platform's:

- `automation-model-request.json` from `e25fd74`, the head of `round-17/model-author-exclusion`
  (its BUILD-PLAN 25.2.29), gains the optional `excludeModelAuthors`: one to three distinct
  model makers, each 1–128 lowercase letters, digits and `. _ -`, the part of a model id
  before its `/`. The SDK's copy of the rule (`excludeModelAuthorsProblem`, `modelAuthor` in
  `packages/automation-sdk/src/model-request.ts`) is held to it by
  `packages/automation-sdk/test/contract-model-request.test.ts`, with the platform's samples.
- `automation-manifest.json` from `550663f`, the head of `round-17/upload-file-measurement`
  (its BUILD-PLAN 25.2.28): the `artifacts` block gains the optional `maximumPdfPages` (1 to
  1,000) and `maximumImageSidePixels` (1 to 20,000), held by
  `packages/automation-sdk/test/contract.test.ts` with the platform's samples. They are the
  limits `manifests/invoice-processing.v1.json` now declares (10 and 8,000): the platform
  measures an upload's pages and pixels only for a manifest declaring one, and without the
  measurements `receive` refuses every file.

The other six files are byte-identical to `4875579`'s (each checked with `cmp` against both
branches, and each branch's copy of the other's file is `4875579`'s). Until those pull requests
merge and are promoted, the live platform answers `excludeModelAuthors` with a 400 and the
schema at its `main` refuses a manifest declaring either limit; each file is re-pinned to its
merge commit then, its bytes unchanged unless a review changed them.

Re-pinned 2026-10-11 at `7086e5e`, the platform's `main` after #197 squash-merged
`round-17/upload-file-measurement` (its BUILD-PLAN 25.2.28): `automation-manifest.json` is
`cmp`-equal to `7086e5e`'s, so the bytes copied from `550663f` are the merged ones and only the
commit above moves; the other six files the platform's `main` carries are `cmp`-equal too, and
its `test/wire-schema.test.ts` samples and `manifest-validation.ts` did not change between
`550663f` and `7086e5e`. `automation-model-request.json` stays as copied from `e25fd74`: the
branch `round-17/model-author-exclusion` was rebased onto `7086e5e`, and its head `2482a2c`
(its BUILD-PLAN 25.2.29 and 25.2.30) carries the same bytes (`cmp`-equal) and the same rule and
samples; it is re-pinned to the merge commit when that pull request merges. Until then and a
promotion, the live platform answers `excludeModelAuthors` with a 400.

`test/architecture.test.ts` validates every file in `manifests/` against
`automation-manifest.json` verbatim; `test/conformance.test.ts` validates the template
directory's example manifest the same way.

## What the platform refuses beyond the schema

The schema says everything a JSON Schema can. The platform's `validateManifest`
enforces these further rules at registration, quoted in its own refusal words so a
refusal is read here before it is received. This section is vendored from the
platform's `manifests/README.md` (ADR-0020 §2); bounds named as "N" are its `LIMITS`.

**Identifiers** — `templateId`, `requiredConnections[].providerId`, `pipeline[].id`:
"must be lowercase letters, digits, and hyphens, starting with a letter", within the id
length. `setup[].key`: "must be camelCase, starting with a lowercase letter".

**Text** — every display string: "must not be empty", "must be at most N characters"
(`displayName` and provider `operation` are shorter).

**`pricing.monthlyPriceUsd`** — "must be a non-negative number"; "must not have sub-cent
precision".

**`requiredConnections`** — a `providerId` "is declared more than once" is refused; the
schema's `uniqueItems` compares whole entries, the validator compares `providerId`
alone, which is stricter. **`requiredCapabilities`** — each "is declared more than
once" refused; here `uniqueItems` is exact.

**`service.origin`** — "must be an absolute URL"; "must use https, or http only for a
non-routable host"; "must not embed credentials"; "must be an origin with no path";
"must not carry a query string"; "must not carry a fragment"; "must be exactly an
origin" — the text you wrote, minus one trailing slash, must equal the origin a URL
parser derives from it, so uppercase, percent-encoding and a port outside 0–65535 are
refused.

**`service.serviceAccount`** — "must be a service account address ending in
.iam.gserviceaccount.com".

**`setup[]`** — a `key` "is declared more than once" refused; `required` "must be a
boolean"; `defaultValue` "must be a `<type>` for a `<control>` control" and, for
`money`, "must not be negative".

**`trigger`** — `connection` "is only meaningful when kind is 'provider-event'";
`everySeconds` "is only meaningful when kind is 'schedule'" and must lie within the
platform's schedule bounds; a `provider-event` trigger cannot name a connection the
manifest does not declare; a trigger kind the platform does not implement is refused at
registration.

**`pipeline`** — "must declare at least the trigger step"; a step `id` "is declared more
than once" refused; "only the first step may be a TRIGGER".

**`artifacts`** — media types "must be a media type, optionally with a \* subtype"; an
empty list "must declare at least one media type — omit `artifacts` entirely to accept no
files"; `maximumSizeBytes` "must be a positive integer" and at most 100 MiB. In the schema
as well since the platform's 25.2.21 (2026-10-10), from the same constants: until then a
manifest declaring `artifacts` passed the validator and failed this copy of the schema.
Since its 25.2.28 (2026-10-10, merged 2026-10-11 as `7086e5e`) two optional limits, measured from the file's
bytes when its upload is sealed: `maximumPdfPages` and `maximumImageSidePixels` each "must
be an integer from 1 to N" (1,000 and 20,000); beside either, every accepted type "must be
application/pdf, image/jpeg or image/png when a page or pixel limit is declared" (the types
the platform measures, which the schema cannot say); and any other key "is not an artifacts
property", as the schema's `additionalProperties: false` already refused it.

**Arrays** — connections, capabilities, setup fields, pipeline steps and scopes per
connection each "must contain at most N entries".

**At registration** — the filename must match `templateId` and `version`; a registered
version is immutable; `service.origin` and `service.serviceAccount` are unique across
registered versions.
