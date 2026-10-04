# The wire contract, vendored

`schemas/` is a byte-for-byte copy of the platform repository's `schemas/` directory
(`snoopy-backend`, private) at commit `db66611`, taken 2026-10-03. The platform emits
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

`test/architecture.test.ts` validates every file in `manifests/` against
`automation-manifest.json` verbatim.

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

**`artifacts`** — media types "must be a media type, optionally with a \* subtype";
`maximumSizeBytes` "must be a positive integer" and at most 100 MiB.

**Arrays** — connections, capabilities, setup fields, pipeline steps and scopes per
connection each "must contain at most N entries".

**At registration** — the filename must match `templateId` and `version`; a registered
version is immutable; `service.origin` and `service.serviceAccount` are unique across
registered versions.
