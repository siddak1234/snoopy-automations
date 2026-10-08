# snoopy-automations

Autom8x automations — the logic that runs when a workspace's automation fires. Each
one is a small service the platform calls, which calls back. **This repository holds
no secret and never will:** an automation receives a run-scoped token at runtime and
nothing else, so it is public by design.

## What an automation is

An automation is **not part of the platform.** The platform never executes
automation logic and an automation never holds a credential — no provider token, no
model key, no database URL. It serves two routes, and everything it is allowed to do
afterwards goes out through the platform, carrying the run token it was handed.

| It serves          | Meaning                                                   |
| ------------------ | --------------------------------------------------------- |
| `GET /health/live` | The catalog probe. Answering is what makes it `available` |
| `POST /v1/invoke`  | Accept or refuse a run, then work asynchronously          |

| It calls back to `callbackOrigin`         | Meaning                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `POST /v1/automations/callbacks/step`     | Progress on one declared step                         |
| `POST /v1/automations/callbacks/result`   | The final outcome: success, held, or failed           |
| `POST /v1/automations/callbacks/model`    | Ask the platform to make a model call, by capability  |
| `POST /v1/automations/callbacks/provider` | Ask the platform to call a provider                   |
| `POST /v1/automations/callbacks/artifact` | Read a file this run was given, by reference          |
| `POST /v1/automations/callbacks/mail`     | Ask the platform to send a mail from its own identity |

Every callback carries `Authorization: Bearer <runToken>` and nothing else. The
token arrives in the invoke, is scoped to that one run, bound to its workspace,
limited to its pinned manifest version, and expires with the run. The platform
checks all four on every callback.

Four rules follow, and the tests enforce them:

- **A held run ends.** `held` is not a pause: the automation returns its state and
  exits, and an approval starts a new run carrying that state back.
- **A step is reported only under an id the manifest declares.** The platform
  refuses any other and does not store it; the runner never starts one.
- **A summary never carries the document it describes.** Timelines are read by
  people and retained far longer than a run.
- **The platform is the only sender.** No automation sends through a customer's
  mailbox (platform ADR-0021): mail goes out through the `mail` callback, from
  automations@autom8x.ai.

## Layout

```
contract/schemas/            the wire contract — JSON Schemas vendored from the platform
packages/automation-sdk/     the step runner, prompt modules, the six callbacks, the serving shell, test doubles
automations/<name>/          one automation per directory, with its own Dockerfile and lockfile
templates/automation/        the template directory: a copyable automation on the runner, tested by the gate
manifests/<name>.v<n>.json   what the platform registers, validated here first and shipped in the image
scripts/repo-facts.ts        emits docs/repo-facts/snoopy-automations.json from the gate
test/architecture.test.ts    the boundary and the engine rule, enforced
test/conformance.test.ts     every automation held to the manifests it serves
```

The boundary is the **wire format, not a package.** Nothing here depends on the
platform's TypeScript packages, because a third-party automation could not either.
`contract/README.md` says which platform commit the schemas were taken from.

## What an automation looks like

An automation is **declared steps, versioned prompts, and a runner** (platform
ADR-0034). The manifest declares the pipeline; the code supplies one function per
step; the runner runs the pipeline of the version the run pinned, in order, reports
each step through the step callback, derives one idempotency key per run and step
and attaches it to every provider request and every mail, and resumes an approval's
continuation at the step after the one that held.

```ts
import { defineAutomation, held, readManifests, serve, type Step } from '@autom8x/automation-sdk';

const receive: Step = async ({ request }) => ({
  outcome: 'ok',
  summary: `Received ${String(request.input.reference)}`,
  state: { reference: request.input.reference },
});

const validate: Step = async ({ request, state }) =>
  Number(request.input.amount) > Number(request.config.holdAboveAmount ?? 500)
    ? held({ summary: 'Above the threshold', heldReason: 'Someone should approve this', state })
    : { outcome: 'ok', summary: 'Within the threshold' };

const notify: Step = async ({ request, state, platform }) => {
  // The platform sends it, with this step's idempotency key attached.
  await platform.sendMail({ to: String(request.config.notifyEmail), subject: '…', body: '…' });
  return { outcome: 'ok', summary: 'Emailed the outcome', state: { ...state, notified: true } };
};

const automation = defineAutomation({
  templateId: 'my-automation',
  manifests: readManifests(process.env.MANIFESTS_DIR ?? 'manifests', 'my-automation'),
  steps: { receive, validate, notify },
  result: (state) => ({ output: { ...state }, summary: 'Done' }),
});

await serve({ templateId: automation.templateId, execute: automation.execute });
```

`defineAutomation` refuses, at startup, a step no served manifest declares, a
declared step with no code, and a prompt whose capability a served manifest does not
list in `requiredCapabilities` — so the container fails its probe rather than its
first run. A step returns `ok`, `skipped` (nothing reported), `failed` (visible; the
run goes on unless it names a `failureReason`), or `held`. A **prompt module** is a
versioned template with its `outputSchema`, kept as `prompts/<id>.v<n>.json` beside
`src/`, rendered from the run's input and sent through the model callback by
capability: the SDK accepts no model name, because the platform chooses what it
spends. The shell answers the probe, acknowledges an invoke before working, refuses
above capacity or while draining, reports the result (or the failure) for you, and
logs ids and outcomes only — an error's message becomes the run's `failureReason`,
so never build one from the document. A test hands the automation a
`RecordingPlatform` from `@autom8x/automation-sdk/testing` instead.

## Model calls

A step sends a REGISTERED prompt module by capability — `platform.callModel(prompt,
input)` — and the platform chooses the model, holds the completion to the prompt's
`outputSchema`, writes one `runs.model_calls` row, and answers `{ text, model,
finishReason, usage }`; `readJsonCompletion` parses the text without ever quoting
it. A completion the platform will not hand over is a **typed refusal**: a
`ModelRefusedError` — a `CallbackRefusedError` whose `callback` is `model` —
carrying the platform's `details.reason` and the fields beside it, and nothing of
the completion's text, so a step can branch on a word:

| status | `reason`                      | what it means, and the fields beside it                                                                                                                                                                                           |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 422    | `output_schema_mismatch`      | the completion is not the document the schema describes; `path` (a JSON path from `$`) and `rule` (the keyword that failed: `type:number`, `required:total`, `enum`, `json`) say where and which, never the value; `finishReason` |
| 422    | `content_filtered`            | the vendor declined (safety, recitation); permanent for that document; `finishReason` is `content_filter`                                                                                                                         |
| 422    | `truncated`                   | the completion stopped at the output budget; retryable with a smaller prompt or document; `finishReason` is `length`                                                                                                              |
| 403    | `over_plan_limit`             | the workspace's plan allows no more completions this month; `used` and `limit`                                                                                                                                                    |
| 403    | `capability_not_in_plan`      | the plan grants no model calls at all; `used`                                                                                                                                                                                     |
| 403    | `entitlements_not_configured` | the platform could not ask entitlements and refused rather than guess; `used`                                                                                                                                                     |

The 422s spent tokens and are ledger rows; the 403s spent nothing. Uncaught, a
`ModelRefusedError` fails the run with a `failureReason` that names the reason
(`the model call was refused with 422: truncated (finish reason length)`), and the
runner's timeline line for the step says `the model call was refused (truncated)`.
Two model refusals are NOT typed, because nothing a step does at run time answers
them: an `outputSchema` the platform cannot hold a completion to (`pattern`, `$ref`,
the tuple form of `items`, …) is a plain 400 `CallbackRefusedError` with no reason
and the keyword in `detail`, and a capability the manifest did not declare is 403
`capability_not_declared`, which `defineAutomation` refuses before the wire. In a
suite, `refusalFixture('model', { status, code, detail, details })` from
`@autom8x/automation-sdk/testing` builds exactly what the client throws for that
answer; `RecordingPlatform.model` rejects with it.

Every refusal the platform answers is an RFC 7807 problem — `{ type, title, status,
detail, instance, code, requestId, details }`, relayed verbatim by the Edge — and
`CallbackRefusedError` reads `code`, `details` and `reason` from the whole body,
never from the 200-character `detail` it keeps for the message. The mail callback's
two pre-transport refusals name themselves the same way (`recipient_inside_workspace`
at 403, `workspace_membership_truncated` at 502), which is what `mailCertainlyNotSent`
reads.

## Invoice intake

`invoice-intake` is the first automation written in this repository. A verified
webhook delivery carrying `vendor`, `amount`, and `reference` starts it. The platform
wraps that JSON in the invoke envelope, deduplicates the delivery, and supplies the
run-scoped token; the automation implements none of that ingress itself.

The subscription configures an approval threshold and the vendor's address.
Invoices above the threshold end their first run held at `validate`, then resume at
`notify` from returned state only after approval. The vendor is told through the
platform's `mail` callback, from automations@autom8x.ai; there is no model callback
and no provider call. One container serves v1, v2 and v3 — v1 still declares a Gmail
scope, by an immutable registered manifest, that nothing here spends.

## Invoice check

`invoice-check` is the platform's first automation, moved here from the platform
repository on 2026-10-08 (its BUILD-PLAN 25.3.8) and ported to the SDK. A manual run
carries `vendor`, `amount`, `reference` and optionally a file; the amount is checked
against the threshold, held above it, and recorded; v2 and later email the outcome
through the platform when an address is set. One container serves v1 to v4, and a
v1 run never reaches `notify` because v1's pipeline does not declare it. Its result
summary is bounded by the SDK before it is sent, so a long reference no longer fails
a run already recorded (platform §12.1 #220).

## Adding an automation

1. Copy `templates/automation` to `automations/<templateId>` and replace `example`
   with your templateId everywhere (`package.json`, `Dockerfile`, `src/`). Give it a
   lockfile: copy an existing automation's `package-lock.json` and change its two
   `name` fields, then run `npm install --package-lock-only --ignore-scripts` at the
   root so the root lock learns the workspace. Write the steps; keep prompts in
   `prompts/`.
2. Write `manifests/<templateId>.v1.json` (the template's `example.v1.json` is a
   valid start). `npm run verify` validates it against the vendored schema and
   `test/conformance.test.ts` checks that every step your code can report is
   declared and every capability a prompt uses is in `requiredCapabilities`.
3. Add the automation to the `matrix` of the Image and Publish jobs in
   `.github/workflows/ci.yml`, or its image is never built.
4. Open a pull request here. CI runs on `GITHUB_TOKEN` alone, builds, smoke-tests
   and scans each image, and on merge publishes each by digest to GHCR, then tags the
   proven digest with the commit.
5. Open a pull request adding the manifest to the platform repository's
   `manifests/` directory, with the container's `.internal` alias and digest pin in
   its `deploy/compose.prod.yml`. There is no registration endpoint, and the
   platform's ADR-0020 decided there will not be one: `service.origin` is where
   customer documents get sent, review is the authorization, and a pull request is
   the only write path that carries one. The rules a manifest must meet beyond the
   schema are in `contract/README.md`, in the validator's own words.
6. Declare the origin as `http://<templateId>.autom8x.internal:8080`. The platform
   gives your container that name as a network alias, so it is reachable only on
   the compose network by construction — the shape every automation here uses.

A registered manifest at a version is **immutable.** Changing anything means a new
file at `v<n+1>` — a run pinned to v1 must still resolve the service it actually
called. The platform's decision of 2026-10-08 (D2) is one container and one image
per manifest version for everything new; `invoice-check` and `invoice-intake` keep
their several versions on one container until the superseded ones are retired.

## Working here

```bash
npm ci --ignore-scripts
npm run verify        # format:check → build → typecheck → test, root, template and every workspace;
                      # then re-emits docs/repo-facts/snoopy-automations.json with the gate's claim
npm run facts         # re-emits the facts file without the claim, after adding or removing files
```

Node 22 or newer. Agent sessions read `CLAUDE.md` first. The committed facts file
is held to the tree by `test/repo-facts.test.ts`: when its counts go stale, run
`npm run facts`, then `npm run verify`, and commit the file.
