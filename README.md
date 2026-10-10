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
and attaches it to every provider request and every mail, re-attempts a step that
declared a retry policy when it fails transiently (below), and resumes an approval's
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
capability; a prompt names no model — the step names the models on the call ("Pick
a model", below). The shell answers the probe, acknowledges an invoke before working, refuses
above capacity or while draining, reports the result (or the failure) for you, and
logs ids and outcomes only — an error's message becomes the run's `failureReason`,
so never build one from the document. A test hands the automation a
`RecordingPlatform` from `@autom8x/automation-sdk/testing` instead.

## Model calls

A step sends a REGISTERED prompt module by capability — `platform.callModel(prompt,
input, models?)` — and the platform makes the call with its own key, holds the
completion to the prompt's `outputSchema`, writes one `runs.model_calls` row, and
answers `{ text, model, finishReason, usage }`, `model` being the one that served;
`readJsonCompletion` parses the text without ever quoting it, and reads an answer
whose `finishReason` is `other` as it reads `stop`, since the platform holds both to
the schema and bills both (the platform's BUILD-PLAN 25.3.12). A completion the
platform will not hand over is a **typed refusal**: a
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
and the keyword in `detail`, which `definePrompt` refuses when the prompt loads, in
the platform's words, from a copy of its keyword list (`output-schema.ts`, the
platform's BUILD-PLAN 25.3.11); and a capability the manifest did not declare is 403
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

## Pick a model

A step names the models its call asks for, or none, and — when the model must read the
run's own file — the file. In the template that is one constant beside the step that calls
the model, and a new automation needs nothing else:

```ts
// Primary first, then up to two fallbacks, from at least two providers.
export const MODELS: readonly string[] | undefined = undefined; // the platform's default

const completion = await platform.callModel(extractFields, input, MODELS);
// With the run's file, which the platform reads and sends; this container never does:
await platform.callModel(extractFields, input, { models: MODELS, artifactId: fileId });
```

- **The primary, then up to two fallbacks, one model per attempt.** The platform asks
  one model at a time, each on its own time limit, and tries the next when an answer is
  unusable — empty, cut off, refused by the model, or not matching the declared
  `outputSchema` — when none comes in time, or when the router refuses the model; each
  attempt the vendor may have billed is its own `runs.model_calls` row (the platform's
  BUILD-PLAN 25.2.20 and 25.2.22, the owner's "runs should not fail"). Naming fallbacks
  is how a step gets that. Left `undefined`, the platform's default models serve, with
  fallbacks of their own.
- **The run's file.** `artifactId` names the run's own upload — this run's or its
  chain's first run's (25.2.18). The platform holds it to the manifest's `artifacts`
  block and its own leading bytes and sends it with every attempt, a PDF as a file and a
  JPEG or PNG as an image; a type the manifest or a model does not take, a file over the
  bound and an encrypted PDF are 422s naming the reason, before anything is spent.
- **The owner's setting wins.** The owner switches any automation's model on the
  platform at once, with no restart and nothing released here (the platform's
  `scripts/set-automation-model.mjs` writes it, and every call reads it); while it is
  set its models — up to three, each with a reasoning setting (25.2.23) — are the only
  ones, whatever `MODELS` says. The switch holds each model to the owner's rules against
  OpenRouter's lists (25.2.24); the models a step names in code are held to them only by
  the router, so name models that would pass them (below), and leave any that must think
  at a lower effort to the owner's setting: a model named here is sent with no reasoning
  setting at all.
- **Refused before anything is sent.** The client refuses, in the words of the
  platform's 400, a list that is empty, longer than three, names an id twice, or holds
  an id outside the platform's rule: 1–128 characters from OpenRouter's lowercase set
  (letters, digits and `. _ : / ~ -`, so no space and no `@` preset), no `:online` (web
  search), no `openrouter/` router (which picks models, and can run tools, the request
  never named) and no `:nitro` or `:floor` variant (the owner's cost guard: a priority
  tier's pricing, a flex tier's latency); and an `artifactId` that is not an upload's id.
  `RecordingPlatform` refuses the same, so a suite is where the mistake shows. A prompt
  file names no model: `definePrompt` refuses `model` and `models` alike.
- **Held by the platform, whatever is named.** Every call is held to zero data
  retention and no data collection, to OpenRouter's endpoints in the United States
  (the platform's 25.2.25, the owner's decision of 2026-10-10), to structured output for
  a declared `outputSchema`, to the owner's price ceiling — \$5 per million prompt tokens
  and \$15 per million completion tokens — and to an answer of about 8,000 tokens at
  most (the owner's cost guard). A model no such endpoint can serve is refused by the
  router, and the platform tries the next. The workspace's monthly allowance is asked
  before each attempt (the 403s above). Choose from OpenRouter's list of zero-retention
  endpoints, `https://openrouter.ai/api/v1/endpoints/zdr`: an entry tagged in the United
  States (`…/us` or `…/us-<region>`) whose `supported_parameters` include
  `structured_outputs`, `response_format`, `temperature` and `max_tokens`, whose
  `pricing` (US dollars per token) is within the ceiling, whose model reads images and
  files when the step sends one, and which is not about to expire. On 2026-10-10
  `anthropic/claude-haiku-4.5` qualified with no setting, and `google/gemini-3.5-flash`
  needed the owner's `@low`; `google/gemini-2.5-flash` and `openai/gpt-4.1-mini` did not
  (no US endpoint).
- **One key, on the platform only.** The platform holds the one OpenRouter key and
  makes every call with it. Nothing in this repository, its images or a running
  container holds a key; a container presents its run token and nothing else.

The platform's half — its BUILD-PLAN 25.2.14 to 25.2.16: OpenRouter, the owner's
setting, and `models` — is live since its TWENTY-EIGHTH promotion (2026-10-09), but its
model gateway stays unconfigured until the owner's OpenRouter key, which comes last on
the owner's order: until then every model call is answered 503, so an automation is
built and tested against a simulated model (`RecordingPlatform`, which answers a call as
the platform does: one model per attempt, `NO_ANSWER` for an attempt that times out, the
platform's refusals in its order), and the template leaves `MODELS` undefined. The
fallbacks, the cap, the run's file, one model per attempt, the reasoning settings and US
routing (its 25.2.17–25.2.25) go live with its next platform promotion.

## Retrying a step

A step is run again after a failure only when its automation declares a policy for
it; a step without one runs once, as every step did before (platform BUILD-PLAN
25.5.1, ADR-0034 decision 5). The platform re-attempts an invoke that was refused or
never answered; a step that fails inside a running automation is the runner's.

```ts
defineAutomation({
  templateId,
  manifests,
  steps,
  result,
  retry: { receive: { attempts: 2, backoffMs: 10_000 } },
});
```

- **Bounded by the SDK.** At most 3 attempts, the first included; `backoffMs` before
  the second and twice that before the third, never more than 30 seconds of waiting
  in all. `backoffMs` is at least 10 seconds (`MIN_STEP_BACKOFF_MS`, the reason is
  under Provider below), so with three attempts the floor is also the ceiling. A
  policy asking for more is clamped — `automation.retry` shows what is applied — and
  one that counts no attempt, waits less than the floor, or names a step with no
  code is refused at startup. No attempt starts at or after the invoke's `deadline`: past it the
  platform refuses every callback (403 `deadline_exceeded`), and a deadline that does
  not parse allows no retry. The figures are integrator figures, not measurements
  (`retry.ts` says why).
- **Only a transient failure.** No answer at all — the request was refused, reset,
  timed out or cut off, which the client marks where it makes the request — or a
  callback answered 502, 503 or 504 without deciding: no `details.reason`, and the
  code `DEPENDENCY_FAILURE` or none (a proxy's page). Never a 4xx (the mail
  allowance's 429 among them), a `ModelRefusedError`, a 5xx the platform typed
  (`workspace_membership_truncated`, `pinned_version_unavailable`,
  `outbound_mail_not_configured`), `NOT_CONFIGURED`, an answer that came malformed, a
  provider's own status (it arrives inside a 200 and is the step's to judge), a link
  the store refused, or anything the step's own code threw. A step that wants the
  retry lets the platform's error through as it came.
- **Or only what never left: `when: 'unsent'`.** A policy with
  `retry: { extract: { attempts: 2, backoffMs: 10_000, when: 'unsent' } }` repeats the
  step only when a callback provably never left the container — the connection was
  refused, or the platform's name did not resolve (`ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN` on the error's `cause`, the split the platform makes for its own vendor
  calls). A timeout, a reset, a cut answer and every status the platform answers are
  not repeated, because the call may have reached the platform. It is the policy for
  a step that calls the model (the platform's BUILD-PLAN 25.3.13, the owner's
  decision of 2026-10-10: after a restart, one retry only if nothing was sent); see
  Model below for why any other repeat of a model call costs.
- **The same key on every attempt.** The whole step runs again, with the same `state`
  (treat it as read-only) and the same idempotency key, so a repeat meets the
  platform's records for that key:
  - **Provider.** The same key and the same request, after a final answer (any
    status below 500 but 401, 403, 408, 425 and 429), is answered from Connections'
    record of the first — `replayed`, the provider not called. Without one — the
    provider unreachable, one of those statuses, or a first call still in flight —
    nothing is recorded yet, and the provider is called again under the same
    `Idempotency-Key` header, which only a vendor that honours it deduplicates; none
    of the platform's registered providers is recorded as doing so. A call can fail
    in the container while it is still running — a reset, a proxy's 502, and before
    the platform's BUILD-PLAN 25.2.13 the Edge giving up on its hop to Runs after 5
    seconds — while Connections carries on for up to 10 seconds and records the
    answer only when it comes. The floor waits out that bound, which in the common
    case — a slow provider behind a fast platform — replays a first call the
    provider answered instead of sending it twice. It narrows the window and does
    not close it: the platform's own work before the provider call does not stop
    either, so a slow platform can start the first call late. A first call with no
    final answer is sent again whatever the wait. So a provider WRITE is safe to
    retry only at a vendor that deduplicates on the key. The same key with a
    different request is refused 409, which reaches the container as a 502 today and
    is retried to the bound, performing nothing (a finding returned to the platform).
  - **Mail.** The same key and the same words claim no further allowance — the
    reservation is keyed on the run, the key and the message's digest — and go to the
    transport again under the same vendor idempotency key, which the transport
    deduplicates. Different words under the same key are a second mail and a second
    unit of the allowance, so a step that may be retried builds the same message
    every time.
  - **Model.** No record: a model call repeated after a completion the container
    never received is a second vendor call, a second `runs.model_calls` row and a
    second unit of the plan's monthly allowance. Declare a policy on a step that
    calls the model only if that cost is acceptable, or declare `when: 'unsent'`,
    which repeats it only when it never left. From the platform's BUILD-PLAN
    25.2.22 the Edge relays a model callback for up to 230 seconds — every attempt
    inside the owner's budget, at most 150, and the waits around it — inside the load
    balancer's 250 and this client's 260 (`DEFAULT_MODEL_TIMEOUT_MS`, in every image
    built since). Before those limits are all live — and whenever the platform's own
    dependencies run a call past them — a model call can reach the container as a 502
    while the platform completes and counts it.
- **Reported once.** The step's one timeline line carries its final outcome and, when
  it took more than one attempt, `(after N attempts)`; a step that failed every
  attempt is `The <step> step failed (after N attempts)` and the run fails with the
  last error. A result the step returns — `ok`, `failed`, `skipped` or `held` — ends
  the attempts, so a held step is never run twice.

Neither automation here declares a policy. `invoice-intake` calls the platform only
in `notify`, and `notify` in both automations catches its own failure and reports
it, so a policy there would never fire; `invoice-check`'s `receive` only reads the
file its run was given and is the one safe candidate. The template declares none
and says why beside its `define`: its `act` is a provider write. In a suite,
`refusalFixture('provider', { status: 502, code: 'DEPENDENCY_FAILURE', detail:
'Runs service is unreachable' })` from `@autom8x/automation-sdk/testing` is a
transient answer to rehearse a retry with; the rehearsal waits the floor, 10
seconds, in real time.

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
their several versions on one container. The superseded ones were retired from the
platform's catalog on 2026-10-09 (its BUILD-PLAN 25.3.8), and the containers keep every
version's alias, so a flow on a withdrawn version still runs.

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
