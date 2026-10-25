# The wire contract, vendored

`schemas/` is a byte-for-byte copy of the platform repository's `schemas/` directory
(`snoopy-backend`, private) at commit `d0e4201`, the platform's `main` after its #242
squash-merged Round 19's build 28 contract, verdict words and a run's verdict (2026-10-25;
"Refreshed 2026-10-24, build 28" below). Before it, `2d93d99`, the platform's `main` after
its #239 squash-merged Round 19's contract, a flow's items (2026-10-24; its ADR-0046; "Refreshed
2026-10-24" below). Before it,
`d371251`, the platform's `main` after its #231 squash-merged Round 18's 27.2 (2026-10-21):
`display.documentWords` ("Re-pinned 2026-10-21" below). Before it,
`708ed6e`, the platform's `main` after its #222
squash-merged Build 24 (2026-10-20): `RunDocument.source` (the file, and its pages when told)
and `RunDocumentRecord.accountName`, both optional (the platform's ADR-0045). First pinned at
`84ed9bc` of its `round-17/b24` branch; `708ed6e`'s tree is that pull request's head's (`3f59de5`,
`be5e0bc`), so all eight files are byte-identical (each checked with `cmp` against `708ed6e`)
and only the commit moved. Before it, `32b33ae`,
the platform's `main` after its #215 squash-merged its Build 22 (below). The platform emits them with
`npm run schemas:emit` and verifies the committed files against its TypeScript types byte for
byte, so this copy is the
contract it publishes to external automation authors. To refresh: copy the directory again
and update the commit above in the same change.

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
  (platform §12.1 #83) — `http://<templateId>-v<n>.autom8x.internal:8080`, the shape the
  platform's ADR-0020 chose for every automation: the container carries the name as a
  network alias, so it is reachable only on the compose network by construction.
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
package and `snoopy-backend/docs/openapi.yaml`'s callback enum names `mail`, but `schemas/` carries no
`automation-mail-request.json`, and the split `snoopy-backend/docs/openapi/automations.yaml` still
names five messages. So the SDK's `MailRequest` is copied from the handler's allow-list —
`to`, `subject`, `body`, `idempotencyKey` (`runId` optional there and never sent) — and
`packages/automation-sdk/test/contract.test.ts` holds it to that list by name. It is the
one message here with no vendored schema to validate against; filed for the platform as a
finding with this refresh.

Refreshed 2026-10-09 at `e0d58d4`: **eight files**. `automation-mail-request.json` arrived — the
platform emits it since `ccc10e4` (#179, its BUILD-PLAN 25.3.7), and its split
`snoopy-backend/docs/openapi/automations.yaml` names `mail` among the callbacks — so the finding above is
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
its `snoopy-backend/test/wire-schema.test.ts` samples and `manifest-validation.ts` did not change between
`550663f` and `7086e5e`. `automation-model-request.json` stays as copied from `e25fd74`: the
branch `round-17/model-author-exclusion` was rebased onto `7086e5e`, and its head `2482a2c`
(its BUILD-PLAN 25.2.29 and 25.2.30) carries the same bytes (`cmp`-equal) and the same rule and
samples; it is re-pinned to the merge commit when that pull request merges. Until then and a
promotion, the live platform answers `excludeModelAuthors` with a 400.

Re-pinned 2026-10-11 at `df4bbad`, the platform's `main` after #198 squash-merged
`round-17/model-author-exclusion` as `c2d6c6b` (its BUILD-PLAN 25.2.29 and 25.2.30) and #199
squash-merged `round-17/quickbooks-writes` (25.2.31): all eight files are `cmp`-equal to
`df4bbad`'s, so `automation-model-request.json`, copied from `e25fd74`, is the merged one and
only the commit above moves. Between `7086e5e` and `df4bbad` only that file changed; the
platform's `snoopy-backend/test/wire-schema.test.ts` and `manifest-validation.ts` did not. Until a promotion
carries `c2d6c6b`, the live platform answers `excludeModelAuthors` with a 400.

Refreshed 2026-10-14 at `9516c0e` — the head of the platform's branch
`round-17/ip-update-platform` (its #210, the Invoice Processing update's PR 1: BUILD-PLAN
25.4.13–25.4.26, ADR-0036 and ADR-0037), not yet merged — as `dcb8ddb` and `1137ac9` were above,
this repository's half built beside the platform's. Two files moved, additively:

- `automation-manifest.json`: `display.category` is one of the sixteen team kinds (ADR-0036 —
  a flow goes to the team of its category; `templates/automation/example.v1.json` moves from
  "Examples" to "Operations"); `requiredConnections[].optional`; the setup control
  `connection`; `pipeline[].group` and the manifest's `groups` (2–6, each an id, a title of
  1–40 and a description of 1–120 characters).
- `automation-run-result.json`: the success branch's optional `details`, 1–20 lines, each a
  `label` of 1–40 and a `value` of 1–200 characters, nothing else. The SDK's
  `boundedDetails` (`packages/automation-sdk/src/details.ts`) bounds what an automation
  returns to it and sends none when there are none.

The other six files are byte-identical to `df4bbad`'s; all eight are `cmp`-equal to
`9516c0e`'s. The rules the schema cannot say are below, and `test/manifest-rules.test.ts`
holds every manifest here to them. Until #210 merges and a promotion carries it, the live
platform refuses a manifest declaring any of these, and v2 of `invoice-processing` cannot be
registered; this copy is re-pinned to the merge commit then, its bytes unchanged unless a
review changed them.

Refreshed 2026-10-16 from the contract of the platform's Build 21 (its BUILD-PLAN 25.4.27–25.4.30,
ADR-0039 and ADR-0040; the branch `round-17/b21-platform`, not yet merged), with the owner's
corrections of 2026-10-15 applied (AM1 and AM7: "no limits other than size"; every document
carries its number, the label printed beside it and its other references) — as `dcb8ddb` and
`1137ac9` were above, this repository's half built beside the platform's. Three files moved,
additively for every automation here:

- `automation-run-result.json`: the success and the held branches' optional `documents` — at
  least one `RunDocument` when sent, with no maximum: `index` (from 1), `status`, `statusText`,
  `type`, `vendor`, `number`, `numberLabel`, `references`, `date`, `time`, `currency`,
  `lineItems`, `lineItemsComplete`, the amounts as decimal strings, `payment`, `recordedIn` and
  `details` (each a `RunDetailLine`). No count and no length is bounded but a detail line's.
- `automation-mail-request.json`: now `oneOf` — the plain mail, unchanged, or the run's results
  (`to`, `template: "run-results"`, `summary`, `documents`, `idempotencyKey`), which the platform
  renders in its one email standard. The SDK sends the plain form alone: the platform mails each
  run's results itself, to the people it picks (the owner's AM3).
- `automation-manifest.json`: a setup field's optional `providers` (1–16 distinct provider ids)
  and `group` (a step group's id) — one connection field per step that uses a connection.

The other five files are byte-identical to `9516c0e`'s; all eight are byte-identical to that
branch's `schemas/` at its `a90a772` (2026-10-17), and still at its `9afdd98` (the same day). Until that branch merges and a promotion
carries it, the live platform refuses `documents` and a manifest declaring `providers` or a
setup `group`; this copy is re-vendored from the merge commit then, its bytes unchanged unless a
review changed them, and `invoice-processing` v3 waits for it.

Re-pinned 2026-10-17 at `69b8d97`, the platform's `main` after #213 squash-merged
`round-17/b21-platform` (2026-10-17 06:50Z): its tree is `9afdd98`'s (`c0b311e`), so all eight
files are byte-identical (each checked with `cmp` against `69b8d97`'s, read from the platform's
API) and only the commit above moves. #210, from which two files came at `9516c0e`, had merged
before it as `57eac70` (2026-10-14). Until a promotion carries `69b8d97`, the live platform
refuses `documents` and a manifest declaring `providers` or a setup `group`; `invoice-processing`
v3 is registered by the platform's pin change once this repository's `main` publishes its image.

Refreshed 2026-10-17, later, from the contract of the platform's Build 22 (the session's spec of
2026-10-17, §1: its BUILD-PLAN 25.4.47–25.4.61 and ADR-0041, built on its branch
`round-17/b22-platform` from `2b9a40b`, not yet merged) — as `dcb8ddb` and `1137ac9` were above,
this repository's half built beside the platform's. Three files moved:

- `automation-manifest.json`: a step group's optional `titleByConnection` — `field`, the id of a
  connection setup field, and `titles`, 1–16 of `{ providerId, title }`, each title 1–40
  characters: the step's title when the flow chose that provider — and `platform`, whose one value
  is `email`: the platform's own step, which mails each run's results. Additive.
- `automation-run-result.json` (16 places) and `automation-mail-request.json` (8): an amount or a
  quantity is `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$` — any number of whole digits and decimals, where
  it was 12 and 4 (the platform's P6; AM1, AM7: no limit but size). It admits more than before.
  The SDK's `RUN_DOCUMENT_DECIMAL_PATTERN` is that pattern, and
  `packages/automation-sdk/test/documents.test.ts` holds it to every place in both files.

The other five files are byte-identical to `69b8d97`'s; all eight are byte-identical to the
session's contract copy for Build 22 (its `b22-contract`, each file's sha256 as its spec's §1.1
lists it). Until that branch merges and a promotion carries it, the live platform refuses a
manifest declaring `titleByConnection` or `platform`, so `invoice-processing` v4 waits for it;
this copy is re-vendored from the merge commit then, its bytes unchanged unless a review changed
them.

Re-pinned 2026-10-18 at `32b33ae`, the platform's `main` after #215 squash-merged
`round-17/b22-platform` (2026-10-18 00:58Z): its tree is the branch head `ec5c2e3`'s (`203781b`),
and all eight files are byte-identical to the copy above (each checked with `cmp` against
`32b33ae`'s, read with `git show`), so only the commit above moves. Its `manifest-validation.ts`
gives the ADR-0041 refusals below in the words quoted there: `test/manifest-rules.test.ts`'s
cases, run against the merged validator, each find the same refusal. The one word that differed,
older than Build 22 — more than six groups, "must contain at most 6 entries", where the port said
"must hold at most 6 items" — is aligned and bitten. `invoice-processing` v1 to v4 each pass the
merged schema and the merged `validateManifest`. The platform's `snoopy-backend/manifests/README.md` still words
the old rule ("group '<id>' has no step"); its validator is quoted here. Until a promotion carries
`32b33ae`, the live platform refuses a manifest declaring `titleByConnection` or `platform`;
`invoice-processing` v4 is registered by the platform's pin change once this repository's `main`
publishes its image.

Refreshed 2026-10-21 from the head of the platform's branch `round-18/backend` (its BUILD-PLAN
27.2.1, Round 18), not yet merged — as `dcb8ddb` and `1137ac9` were above, this repository's half
built beside the platform's. One file moved, additively: `automation-manifest.json`'s `display` gains
the optional `documentWords`, `{ singular, plural }`, each 1–40 characters — what a flow calls one
of the documents its runs return, and many, which the platform publishes on the catalog entry and
both clients and the run package print ("Invoice 1 of 3"; a flow that declares none, "Document 1 of
3"). `manifests/invoice-processing.v7.json` declares "Invoice" and "Invoices" (27.3.2). The other
seven files are byte-identical to `708ed6e`'s (each checked with `cmp`). Until that branch merges
and a promotion carries it, the live platform refuses a manifest declaring `documentWords`, so v7
is registered only by the platform's pin change after both; this copy is re-pinned to the merge
commit then, its bytes unchanged unless a review changed them.

Re-pinned 2026-10-21 at `d371251`, the platform's `main` after #231 squash-merged `round-18/backend`
(23:02:39Z): all eight files are byte-identical to it (each checked with `cmp` against
`git show d371251:schemas/<file>`), so only the commit above moves. The live platform accepts
`documentWords` once a promotion carries `d371251` — the pin that serves v7 (its BUILD-PLAN 27.4.1).

Refreshed 2026-10-24 from the head of the platform's branch `round-19/items`, `7a4baa6` (Round
19's contract: its ADR-0046, a flow's items), not yet merged — as `dcb8ddb` and `1137ac9` were
above, this repository's half built beside the platform's. Three files moved, additively:

- `automation-manifest.json`: the optional `items` block — `words` and `runWords`
  (`{ singular, plural }`, each 1–40 characters); `titleField` and the optional `groupField`,
  field keys; `fields`, 1–4, each a `key`, a `title`, an optional `description`, `required` and a
  `control`: `text`, with an optional `maxLength` of 1–200, or `select`, with 1–32 unique `options`
  of 1–40 characters, an optional `allowOther` and an optional `defaultValue`; `file` (`key`,
  `title`, `description`); `pipeline`, the item run's 1–8 steps (`id`, `title`, `description`);
  and `outputSchema`, the reading's, an object schema. `manifests/candidate-reviewer.v1.json`
  declares one.
- `automation-invoke-request.json`: the optional `item` — `id`, `fields` (each a string) and
  `reading` (an object, or null on the item run itself) — and `readsItem`, whose one value is
  `true`, sent only on the item run. The SDK's `InvokeRequest` reads both
  (`packages/automation-sdk/src/item.ts`), and its runner runs `items.pipeline` on an item run.
- `automation-run-result.json`: the success branch's optional `title` (1–80 characters), `score`
  (an integer from 0 to 100) and `sections` (1–12, each a `title` of 1–40 characters and 1–40
  `entries`: a `title` of 1–120, and optionally a `subtitle` of 1–120, a `text` of 1–600 and a
  `url` of at most 2,048 starting `http://` or `https://` in either case). The platform also
  refuses a url a URL parser does not read as `http:` or `https:`, which a schema cannot say. The
  SDK's `boundedTitle`, `boundedScore` and `boundedSections`
  (`packages/automation-sdk/src/sections.ts`) bound what an automation returns to all of it.

The other five files are byte-identical to `d371251`'s, and all eight to `7a4baa6`'s (each checked
with `cmp`). **Re-pinned 2026-10-24** to `2d93d99`, the platform's `main` after #239 squash-merged that
branch: all eight byte-identical to it (`cmp`), and its validator's items refusals unchanged (only two
helpers' parameter types widened). Until that branch merges and a promotion carries it, the live platform refuses a
manifest declaring `items` and a result carrying `title`, `score` or `sections`, so
`candidate-reviewer` v1 is registered only by the platform's pin change after both; this copy is
re-pinned to the merge commit then, its bytes unchanged unless a review changed them.

Refreshed 2026-10-24, build 28, from the head of the platform's branch `round-19/feedback-b28`,
`cf17dbb` (Round 19's build 28 contract), not yet merged — as `7a4baa6` was above, this
repository's half built beside the platform's. Two files moved, additively:

- `automation-manifest.json`: `items` gains the optional `verdictWords`, `{ positive, negative }`,
  each 1–40 characters — what a run's verdict is called, which the platform publishes on the
  catalog's items and both clients print. `manifests/candidate-reviewer.v2.json` declares "Advance"
  and "Decline".
- `automation-run-result.json`: the success branch's optional `verdict`, `positive` or `negative`,
  which the platform keeps with the run and counts on its item. Beyond the schema, the result
  callback answers 400 with `details.field: verdict` when the run's pinned version declares no
  `items.verdictWords`, and on an item run (the platform's `snoopy-backend/docs/openapi/automations.yaml`).
  The SDK's `boundedVerdict` (`packages/automation-sdk/src/sections.ts`) keeps a verdict only when
  it is one of the two; `candidate-reviewer` v2 gives one on a candidate's run and never on a
  job's.

The other six files are byte-identical to `2d93d99`'s, and all eight to `cf17dbb`'s (each checked
with `cmp`). Re-pinned 2026-10-25 to `d0e4201`, #242's merge: all eight byte-identical to it
(`cmp`), the review between them having changed only the OpenAPI's words. Until a promotion
carries it, the live platform refuses a manifest declaring `verdictWords` and a result carrying
`verdict`, so `candidate-reviewer` v2 is registered only by the platform's pin change after it.

`test/architecture.test.ts` validates every file in `manifests/` against
`automation-manifest.json` verbatim; `test/conformance.test.ts` validates the template
directory's example manifest the same way.

## What the platform refuses beyond the schema

The schema says everything a JSON Schema can. The platform's `validateManifest`
enforces these further rules at registration, quoted in its own refusal words so a
refusal is read here before it is received. This section is vendored from the
platform's `snoopy-backend/manifests/README.md` (ADR-0020 §2); bounds named as "N" are its `LIMITS`.

**Identifiers** — `templateId`, `requiredConnections[].providerId`, `pipeline[].id`:
"must be lowercase letters, digits, and hyphens, starting with a letter", within the id
length. `setup[].key`: "must be camelCase, starting with a lowercase letter".

**Text** — every display string: "must not be empty", "must be at most N characters"
(`displayName` and provider `operation` are shorter).

**`pricing.monthlyPriceUsd`** — "must be a non-negative number"; "must not have sub-cent
precision".

**`display.category`** — "must be one of: HR, Accounting, Finance, …" — one of the sixteen team
kinds, spelt exactly (ADR-0036): a flow added from the catalog goes to the workspace's team of its
category. The schema says it as an `enum`.

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
registration. `input` (ADR-0030) "is only meaningful when kind is 'manual'"; each field takes the
setup field's properties except `section` and `notifies` — anything else "is not a run input
property" — and its `control` is `text`, `money`, `toggle`, `email` or `artifact`; an `email`
value "must be an email address for an email control"; an `artifact` field "must be false for an
artifact control" when required and "is not meaningful for an artifact control" with a default —
a file is uploaded, never required or shared; a key "is declared more than once" refused.

**`pipeline`** — "must declare at least the trigger step"; a step `id` "is declared more
than once" refused; "only the first step may be a TRIGGER".

**Optional connections and the vendor choice** (ADR-0037, from `9516c0e`) —
`requiredConnections[].optional` "must be a boolean"; a `connection` setup field "must be
'connections' for a connection control" (its `section`), "must be false for a connection
control" (`required`) and "must be 'none' for a connection control" (`defaultValue`); a
choice "is only meaningful when requiredConnections has an optional entry"; a manifest with an
optional connection and setup fields but none of them a choice: "an optional connection needs
one setup field with control 'connection'"; a `provider-event` trigger "must name a required,
not optional, connection".

**One connection per step** (ADR-0040, Build 21) — "only one setup field may have control
'connection'" is gone: a manifest may declare one connection field per step that uses one. A
field's `providers` "is only meaningful on a connection control", "must name 1 to 16
providers", each "must name optional connections only" and none "is declared more than once";
with two or more connection fields, each "with more than one connection field, each must name
its providers", and none "names <id>, which another connection field names"; every optional
connection is chosen by one field — "optional connection '<id>' is chosen by no connection
field" — or by a manifest's one field that names none, which chooses among them all. A setup
field's `group` "must name a declared group", and without `groups`, "group is only meaningful
when groups are declared". A flow's choice "must be 'none' or one of this field's providers".

**Step groups** (ADR-0037, from `9516c0e`) — `groups` "must declare at least 2 groups", an
id "is declared more than once" refused, a key besides `id`, `title`, `description`,
`titleByConnection` and `platform` "is not a group property"; each step's `group`: "every step
needs a group when groups are declared", "must name a declared group", "the trigger step belongs
to the first group", and without `groups`, "group is only meaningful when groups are declared".
Steps may come back to a group — v2's `verify-read` follows `check-document`.

**A step that is a setting, the platform's step, a title by connection** (ADR-0041, Build 22;
its `manifest-validation.ts` at `32b33ae`, in its words) — a group no pipeline step names is
a step that is a setting, named by at least one setup field's `group`, or the platform's: else
"group '<id>' has no step and no setting" (it was "group '<id>' has no step"). A group's
`platform` "must be email"; "only one group may be the platform's"; "the platform's step is the
last group"; "no pipeline step may be in the platform's step"; "no setting may be in the
platform's step". A `titleByConnection`'s `field` "must name a connection field"; each of its
`titles[].providerId` "must be one of that field's providers" — its `providers`, or every optional
connection for a manifest's one field naming none — and none "is declared more than once"; 1–16
titles of 1–40 characters, as the schema says. Groups stay at most 6: "must contain at most 6
entries". `test/manifest-rules.ts` ports every rule in this section, and
`test/manifest-rules.test.ts` holds every manifest here to them, each refusal bitten.

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

**A flow's items** (ADR-0046, Round 19; its `manifest-validation.ts` at `2d93d99`, in its
words — `snoopy-backend/manifests/README.md` names them since its #239) — `items` "needs
trigger.kind 'manual': a person makes an item and starts its runs" and "needs an artifacts block:
an item is made from a file"; a key the schema does not name "is not an items property" (and so
in a field, the file, a step and the words); a field's `key` camelCase, none "is declared more
than once"; `options`, `allowOther` and `defaultValue` each "is only meaningful on a 'select'
field", and `maxLength` "is only meaningful on a 'text' field"; a select "must declare at least 1
option", none "is declared more than once", and its `defaultValue` "must be one of options";
`titleField` "must name a field of items.fields" and "must name a required field: its value names
the item"; `groupField` "must name a 'select' field of items.fields"; `file.key` "must not be a key
of items.fields" and "must not be a key of trigger.input"; an item step's `id` shaped as a step
id, none "is declared more than once", and none "is a pipeline step id: an item run reports its
own steps"; `outputSchema.type` "must be 'object': the reading is an object", every keyword in it
one the platform holds an output to — else "uses <keyword>, which the platform cannot hold an
output to" — nested at most 32 levels. A manifest accepting a type outside PDF, JPEG and PNG
declares no page or pixel limit (`artifacts`, below). Since `cf17dbb` (build 28), `verdictWords`
"must be an object", a key besides `positive` and `negative` "is not a verdict word", and each word
is a display string of at most 40 characters ("Text", above); of these only a blank word, "must not
be empty", is one the schema cannot say. `test/manifest-items.ts` ports the rules here the schema
cannot say, `test/manifest-rules.ts` the `artifact` field's two rules above, and
`test/manifest-items.test.ts` bites each.

**Arrays** — connections, capabilities, setup fields, run input fields, pipeline steps and
scopes per connection each "must contain at most N entries".

**At registration** — the filename must match `templateId` and `version`; a registered
version is immutable; `service.origin` and `service.serviceAccount` are unique across
registered versions.
