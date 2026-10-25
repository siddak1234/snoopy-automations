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
packages/automation-kit/     a library automations build with: QuickBooks calls, value cleaning, a QuickBooks simulator
automations/<name>/          one automation per directory, with its own Dockerfile and lockfile
templates/automation/        the template directory: a copyable automation on the runner, tested by the gate
manifests/<name>.v<n>.json   what the platform registers, validated here first and shipped in the image
scripts/repo-facts.ts        emits docs/repo-facts/snoopy-automations.json from the gate
test/architecture.test.ts    the boundary, enforced; every package shipping its dist on Node built-ins
test/isolation.test.ts       the engine rule: no automation shares code, files or an image with another
test/conformance.test.ts     every automation held to the manifests it serves
docs/MAP.md                  generated (npm run map): automations, packages, scripts, tests, agents, hooks, records
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
so never build one from the document; an answer that never came (a callback refused,
reset, timed out or cut off, which the client marks — `isUnanswered`) becomes one fixed
sentence instead, `UNANSWERED_REASON`: "The platform did not answer in time, so the run
stopped." A test hands the automation a `RecordingPlatform` from
`@autom8x/automation-sdk/testing` instead.

A run's `result` may return `details` beside its summary: at most 20 `{ label, value }` lines a
person reads on the run, which the platform keeps with a succeeded run and shows to the
workspace (its ADR-0037; the run result's `details`). The SDK bounds them before they are sent
(`boundedDetails`: one line each, a label of 40 characters, a value of 200, empty ones dropped,
none sent when none are left). And an automation may give `recover(stepId, error, context)`:
when a step THREW and its attempts are spent, it may return a step result that ends the step
instead of the run — reported as any result is, its `failed` without a `failureReason` letting
the run go on. `invoice-processing` uses it to end a QuickBooks step that never answered "not
recorded in QuickBooks" and save the details instead (below); `undefined` lets the run fail as
before.

**A flow's items** (the platform's ADR-0046, Round 19). A manifest may declare `items`: things a
person makes once, from a file, that its runs then belong to — Resume Screening's jobs. Making
one starts an **item run**: the invoke carries `readsItem: true`, the item's file under
`items.file.key` in its `input`, and the runner runs that version's `items.pipeline` instead of
its `pipeline` — those steps there and only there; a version without items has no item run, and
the runner fails one in a fixed sentence. The item run's success `output` is the item's reading,
which the platform holds to `items.outputSchema`. Every later run of the item carries `item` —
its `id`, the `fields` a person gave it and its `reading` (`InvokeItem`; null on the item run) —
and its success may return a `title` (what names it on the item's list), a `score` (an integer
from 0 to 100 the item's runs are ranked by), a `verdict` (build 28: `positive` or `negative`,
which its item counts and the manifest's `items.verdictWords` name; where the platform refuses
one: [contract/README.md](contract/README.md)) and `sections` (rows a person opens: up
to 12, each of up to 40 entries with a title, a subtitle, a text and an http(s) link). The SDK
bounds those before they are sent (`packages/automation-sdk/src/sections.ts`): a title one line of
at most 80 characters, a score kept only when it is such an integer — never rounded or moved into
range — a verdict only when it is one of the two, each row cut at its bound, a link the platform
would not keep left off its row, and none sent when none is left. `defineAutomation` refuses at
startup an item step with no code and an id declared in both pipelines; `itemFixture` and
`declaredItemSteps` in `@autom8x/automation-sdk/testing` build an item for a suite and read a
manifest's item steps.

## Model calls

A step sends a REGISTERED prompt module by capability — `platform.callModel(prompt,
input, models?)` — and the platform makes the call with its own key, holds the
completion to the prompt's `outputSchema`, writes one `runs.model_calls` row, and
answers `{ text, model, finishReason, usage }`, `model` being the one that served;
`readJsonCompletion` parses the text without ever quoting it, and reads an answer
whose `finishReason` is `other` as it reads `stop`, since the platform holds both to
the schema and bills both (the platform's BUILD-PLAN 25.3.12). Every string it returns
is storable: a NUL dropped and half a surrogate pair U+FFFD, since the platform keeps a
run's held state, output and documents as `jsonb`, which holds neither. A completion the
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
| 422    | `no_model_left`               | every model that would serve the call is by a maker its `excludeModelAuthors` leaves out ("Pick a model", below); refused before the file is read                                                                                 |

The first three 422s spent tokens and are ledger rows; `no_model_left` and the 403s spent
nothing. Uncaught, a
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
run's own file — the file. That is one constant beside the step that calls the model, and a
new automation needs nothing else. The template's is `undefined`, the platform's default,
which it passes alone; in the options object a list must be a list, since
`exactOptionalPropertyTypes` refuses `models: undefined` — `invoice-processing`'s is typed
`readonly string[]`:

```ts
// Primary first, then up to two fallbacks, by at least two makers.
export const MODELS: readonly string[] = [
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.1-flash-lite',
];

const completion = await platform.callModel(extractFields, input, MODELS);
// With the run's file, which the platform reads and sends; this container never does:
await platform.callModel(extractFields, input, { models: MODELS, artifactId: fileId });
// A second read that must be another maker's than the model that served the first:
const maker = modelAuthor(completion.model);
await platform.callModel(extractFields, input, {
  models: MODELS,
  ...(maker === undefined ? {} : { excludeModelAuthors: [maker] }),
  artifactId: fileId,
});
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
- **Leaving out a maker.** `excludeModelAuthors` names up to three makers — a maker is the
  part of a model id before its `/`, `modelAuthor` reads it (an alias's after its `~`) —
  whose models the platform removes from whichever list serves the call, the owner's
  setting, `models` or its default, keeping the rest in order (its BUILD-PLAN 25.2.29, the
  owner's "Approve group 2" of 2026-10-10). A list left with no model is a 422
  `no_model_left`, before the file is read and with nothing spent; an id with no `/` names
  no maker and stays. The client and `RecordingPlatform` refuse a list outside the rule —
  one to three distinct makers of 1–128 lowercase letters, digits and `. _ -` — before
  anything is sent, in the words of the platform's 400.
- **The owner's setting wins.** The owner switches any automation's model on the
  platform at once, with no restart and nothing released here (the platform's
  `snoopy-backend/scripts/set-automation-model.mjs` writes it, and every call reads it); while it is
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
  `anthropic/claude-haiku-4.5` (Amazon Bedrock in the US) and `google/gemini-3.1-flash-lite`
  (Google Vertex in the US) qualified with no setting, and `google/gemini-3.5-flash` needed
  the owner's `@low`; `google/gemini-2.5-flash` and `openai/gpt-4.1-mini` did not (no US
  endpoint).
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
routing (its 25.2.17–25.2.25) go live with its next platform promotion; `excludeModelAuthors`
(its 25.2.29) and the measured uploads `receive` reads (its 25.2.28) are pull requests not
yet merged, so until they are promoted the platform answers `excludeModelAuthors` with a 400
and sends no measurements.

## The Edge's flood valve

Every callback reaches the platform through its Edge, which sheds a flood before it reads
anything: 120 requests a minute per source, counted in a fixed one-minute window (the platform's
`snoopy-backend/apps/api/src/app.ts`, `DEFAULT_EDGE_RATE_LIMIT`). In production every automation on a host
calls back through the same address, so they share that one bucket, and one Invoice Processing
document costs 25–44 callbacks. The Edge's refusal is a 429 problem with the code
`TOO_MANY_REQUESTS`, no `details.reason`, and a `retry-after` header — the whole seconds until
the window turns, at most 60 — and nothing behind it ran: nothing reached Runs, nothing was
spent. So the client waits it out itself, the owner's decision of 2026-10-12 ("Wait and
retry"): every callback — a step report, a provider or model call, a file read, a mail, the
result — that the flood valve turns away is sent again, the same bytes, once the window turns
(`packages/automation-sdk/src/flood.ts`). It waits as long as `retry-after` says, in whole
seconds; without one it can read, the whole minute; never more than a minute, nor less than a
second. It waits only while the wait would end before the invoke's `deadline` — `clientFor`
hands the client the invoke's, and a client given none never waits — and a wait that would not
throws the refusal as before. A burst then slows down instead of failing; before this, a result
refused halfway through one left its run "running" until the deadline (`result_unreportable`).
Only that refusal: a 429 that names a reason — the mail allowance's, a workspace's quota — is
the platform's decision and is thrown at once, as is any other status. A step never sees the
waits; one that receives the flood valve's 429 had no time left to wait, and its retry policy
does not repeat a 4xx (below).

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
  allowance's 429 among them, and the Edge's flood valve's, which the client has already
  waited out while the deadline allowed — above), a `ModelRefusedError`, a 5xx the platform typed
  (`workspace_membership_truncated`, `pinned_version_unavailable`,
  `outbound_mail_not_configured`), `NOT_CONFIGURED`, an answer that came malformed, a
  provider's own status (it arrives inside a 200 and is the step's to judge), a link
  the store refused, or anything the step's own code threw. A step that wants the
  retry lets the platform's error through as it came.
- **Or only what never left: `when: 'unsent'`.** A policy with
  `retry: { extract: { attempts: 2, backoffMs: 10_000, when: 'unsent' } }` repeats the
  step only when a callback provably never reached the platform — the connection was
  refused, or the platform's name did not resolve (`ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN` on the error's `cause`, the split the platform makes for its own vendor
  calls) — or, the owner's D8 of 2026-10-10, it was answered 503 naming no code: every
  refusal the platform writes names one, and the Edge's own relay failure is a 502, so a
  codeless 503 is a page from in front of it (the load balancer, or the proxy with no Edge
  up behind it). A timeout, a reset, a cut answer, a 502 and every status the platform
  writes are not repeated, because the call may have reached the platform. `isUnsent`
  (exported) is the test: a step that turns the platform's refusals into sentences lets
  such a failure through as it came, or the runner never sees it. It is the policy for
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
    retry only at a vendor that deduplicates the repeat. QuickBooks does: the platform
    derives its `requestid` from the step's key (its BUILD-PLAN 25.2.26), and Intuit
    answers a repeated `requestid` with its first answer — the same record and Id, the
    body sent again ignored, two copies in flight and 75 minutes later alike (sandbox S6,
    2026-10-12). A repeat the platform refuses — the connection retired while it waited,
    the flood valve with no time left, the deadline — says nothing of the attempt that
    went unanswered, which may have made the record, so the kit's write calls it not
    confirmed, never "nothing was created" ("The kit", below). The same key with a different
    request is refused 409 `CONFLICT` naming `idempotency_key_reused`, which the platform
    relays typed (its BUILD-PLAN 25.2.27, §12.1 #242, live since its TWENTY-NINTH
    promotion, 2026-10-12): a 4xx is never repeated, so it performs nothing more, and the
    kit reads it as a write QuickBooks did not confirm.
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

`invoice-processing` (v6) declares `{ attempts: 3, backoffMs: 10_000 }` for each of its
reads and for its four QuickBooks write steps, `create-vendors`, `create-records`,
`create-approved-vendors` and `create-approved-records`, each writing once per document under
the document's part (the owner's "Retry the creates", 2026-10-12, on sandbox S6 — the kit's
`writeQuickBooks` throws the transient failures on, for the retry), and `{ attempts: 2,
backoffMs: 10_000, when: 'unsent' }` for its two model steps, `extract` (one call per part)
and `verify-read` (one call per 20 doubtful documents); a repeat of either goes on from the
call that never left, never sending an answered call again. The
template declares none and says why beside its `define`: its `act` is a provider
write. In a suite, `refusalFixture('provider', { status: 502, code:
'DEPENDENCY_FAILURE', detail: 'Runs service is unreachable' })` from
`@autom8x/automation-sdk/testing` is a transient answer to rehearse a retry with; the
rehearsal waits the floor, 10 seconds, in real time.

## Retired: invoice-intake and invoice-check

`invoice-intake`, the first automation written here, and `invoice-check`, the platform's first,
moved here on 2026-10-08, left production with the platform's BUILD-PLAN 25.4.5 (2026-10-13) and
this repository with its 25.4.11 (2026-10-22): their code, their manifests and their images'
publishing. The platform's catalog keeps their rows, withdrawn, never deleted; their history is in
`docs/records/round-record.archive.md`.

## Invoice processing

`invoice-processing` — shown to people as **Invoice Processing** since v2, as **Bills &
Receipts** in v1 — reads every bill, invoice, receipt, credit note, statement and other
financial document in a PDF or photo, then saves each one's details for the team, or records it
in QuickBooks Online and compares a statement with it (the platform's BUILD-PLAN 25.4.1,
25.4.13–25.4.30, 25.4.54; the owner's design of 2026-10-10, plan of 2026-10-11, build-19 feedback
of 2026-10-14, Build 21 corrections of 2026-10-15 and build-21 feedback of 2026-10-17).

**v7, the version this code serves** (Round 18, the platform's BUILD-PLAN 27.3.2; the owner,
2026-10-21: "invoice is invoice processing specific"). v7 is v6 whose manifest names its documents —
`display.documentWords`, "Invoice" and "Invoices" — so the website, the app and the run package head
each document "Invoice 1 of 3" from the flow's own words, and any other flow "Document 1 of 3"; its
code is v6's. `automations/invoice-processing/test/manifest.test.ts` holds that v7 is v6 but for its
version, its own container and those words; the image serves v7 alone (its Dockerfile copies only
`manifests/invoice-processing.v7.json`); v1 to v6 stay registered and immutable, each held to its
sha256.

**v6** (Build 24; the owner's build 23 feedback of 2026-10-20, F15 and
F16). v6's results also say, for each document, the uploaded file it came from (`source.file` — a run
has one upload; its pages are not told, because the read does not report them) and, for a recorded
one, the QuickBooks company it went to (`recordedIn.accountName`, from the state its write saved):
what the run page's Format and the run package's cover read (the platform's ADR-0045). Its manifest
is v5's but for its version and its own container — `automations/invoice-processing/test/manifest.test.ts`
holds that. The SDK's `boundedDocuments` carries both fields and leaves out each value the published
schema refuses — a `source.file` not in the platform's artifact-id shape (`ARTIFACT_ID_PATTERN`: a
UUID whose version digit is 1–8 and variant digit 8, 9, a or b), pages that are not whole numbers
from 1, strictly ascending, at most 500 of them, an `accountName` past 200 characters — and keeps
the document itself (`packages/automation-sdk/src/documents.ts`).

**v5** (Build 23; the owner's build 22 feedback of 2026-10-18) — served until v6's release. v5 is
v4 with step 5 named **"Run completed"** ("Done when the run succeeds.") instead of "Email sent": the
clients check it only when the run succeeds, and a held run's approval email never checks it. Nothing
else moved — `automations/invoice-processing/test/manifest.test.ts` holds v5 to v4 less the version,
the container's origin and service account, and step 5's words. The image serves v5 alone
(`SERVED_VERSIONS`; its Dockerfile copies only `manifests/invoice-processing.v5.json`); v1 to v4 stay
registered and immutable, held to their sha256 by the same test.

**v4** (Build 22; the session's spec of 2026-10-17, §3, V1) — served until v5's release. Its
image served v4 alone; v1, v2 and v3 stay registered and immutable,
`automations/invoice-processing/test/manifest.test.ts` holding each to its sha256. v4 is v3's automation, unchanged — the same 22
steps, prompts, checks, holds, QuickBooks writes, result and `outputSchema`, and the same model
calls per file: `automations/invoice-processing/test/v4.test.ts` runs one file on v4's manifest and on v3's and finds the same
steps reported, the same calls and the same result — shown in the five steps the owner asked for
on build 21 (2026-10-17: "1. Upooad Invoice / 2. Connect integration … / 3. Then something about
AI Processing / 4. Quickbooks updated / 5. Email sent"): **Upload invoice** (`receive`) ·
**Connect integration** (no step of the run: the flow's `vendor` choice, titled "Integration") ·
**AI processing** (`extract`, `check-documents`, `verify-read`) · **QuickBooks updated** when the
flow chose QuickBooks, **Details saved** with None (the other 18 steps; the group's
`titleByConnection`) · **Email sent** (`platform: "email"`, the platform's step). Step 3's and step
4's words are the session's suggestions D2 and D3, which the owner approved; the mapping, the
vendor's title and its step are the session's choices (its S18, S19). The approval limit is in no
step (Set up only). No email setting, and the run sends no mail: the platform mails each run's
results to the workspace's owners and admins, the person who started it and any address an owner
or admin adds on step 5's screen (D1, the session's suggestion the owner approved, replacing AM3).
Every v3 setting key is v4's, so the platform's move of each flow to v4 keeps it. The platform's
Build 22 merged as `32b33ae` (its #215; `contract/README.md`); until a promotion carries it, v4
cannot be registered. What follows describes v3, v2 and v1; where they differ, this paragraph
wins.

**v3** (Build 21; the session's spec B1–B6 as the owner's AM1–AM8 change it). Its image served v3
alone; v1 and v2 stay registered and immutable, and v3 since the platform's thirty-second pin (its
#214). A file holds
any number of documents: `extract` reads them all with `automations/invoice-processing/prompts/extract-documents.v1.json`, in
parts — at most 5 documents and 80 lines a part, fewer when an answer is cut at the platform's
8,000-token cap — each its own entry with its own seller and details (`automations/invoice-processing/src/run/extract.ts`,
`automations/invoice-processing/test/documents-parts.test.ts`). Nothing is left out silently: a part that says the file is done
while it counts more documents than were read is followed by one from the next document, and a
reading still short of that count has its last document wait, "the file may hold more
documents"; a reading stopped inside a document marks its lines — a statement's rows too —
incomplete (`automations/invoice-processing/test/documents-counted.test.ts`). Each QuickBooks lookup and write runs once per document,
under its document's part of the step's key (`<key>.d1`, the SDK's `part`;
`automations/invoice-processing/src/run/fan-out.ts`); the three company reads run once for all. One document never fails the
others: one the checks cannot use is read again (`verify-documents.v1`, 20 a call), and one
still unclear — or a page clearly not a financial document — waits for one approval that names
each ("Document 2: the total can't be read.") while the rest are recorded or saved; a quote, a
purchase order, a bank statement or any other financial document QuickBooks keeps no record of
is saved with all its data (AM8; `automations/invoice-processing/test/documents-hold.test.ts`).
Two documents in one file with the same seller, date and total make the later one wait, "same
as document 1" (B1). That doubt alone never keeps a document out: two bills with their own
numbers, a bill and its credit note, or a receipt and its refund are each recorded. A copy is kept
out only when the ONE duplicate rule (`automations/invoice-processing/src/decide/duplicate-rule.ts`)
matches its twin's record: a twin recorded in the first run is found by confirm-no-duplicates'
lookup — "Saved. Not recorded in QuickBooks: may already be in QuickBooks" — and a twin written
after the approval, which that check runs too early to see, by the write itself — "Saved. Not
recorded in QuickBooks: same as document 1" (Gate 25's R5d, PR #47's review;
`automations/invoice-processing/src/run/writes.ts`, `automations/invoice-processing/test/copies.test.ts`). A receipt's or a card
refund's seller QuickBooks has no vendor for is added as one only when every check of its name
is clear (B3), and never keeps its expense out: refused, or unanswered once the step's repeats
are spent, the expense is recorded naming no vendor, the seller in its memo. The result carries
every document whole (`RunDocument`, `automations/invoice-processing/src/run/documents.ts`): its type (`invoice` among them), seller
and place, `number`, `numberLabel` and `references`, date and time, each line's words, quantity,
unit price and amount, the totals as decimal strings, how it was paid, `recordedIn` and the
lines a person reads beside it — no limit but the callback body's 256 KiB
(`RESULT_BODY_LIMIT_BYTES`; AM1, AM7): past it, the SDK's `boundedResult` leaves out a success's
`output`, and sends a held run's documents without their lines (`lineItems` empty,
`lineItemsComplete` false), so the run page and the waiting email still show each one's seller,
number, totals and status, leaving the documents out only when even that does not fit. It never
leaves out the held state, which carries every read for the continuation's result, so the reads
themselves are the bound: measured with lines whose descriptions run to about 60 characters, a
file of 2,000 lines is sent, and one of 2,100 is refused, held or not, and the run fails. A NUL
or half a surrogate pair, which the platform cannot store, never reaches it
(`boundedDocuments`). The run sends no mail and has no email setting: the platform mails each
run's results to the person who started it, or the owner and admins (AM3).
Four step groups — Received, Read, Checked, Done — over 22 steps. Each prompt has at most 16
fields typed with a union, Anthropic's limit for structured outputs: a text not printed is `""`,
no next part `0`. A PDF may have any number of pages (the page cap dropped, AM1 and AM7; an
image's 8,000 px kept, the size the models take). v2's recordings were made for v2's prompts and
are removed with them; v3's are still to be made (`automations/invoice-processing/scripts/recording-request.ts`). The
platform's Build 21 contract merged as `69b8d97` (`contract/README.md`). What follows describes
v2 and v1, and what v3 keeps of them; where they differ, this paragraph wins, and v4's above it.

**v2.** Its image served v2 alone; v1's manifest stays, registered and immutable, until it is
retired. v2's manifest is category Accounting; QuickBooks is an optional connection,
chosen in its one `connection` setup field, `vendor` — "None" by default; two settings, the
approval limit and "Also email", neither required, and no setting can fail a run
(`automations/invoice-processing/test/settings.test.ts`); no "paid personally" input (decision 4) — `find-payer`, the owners
setting and the journal entries are gone; and five visible step groups — Received, Read,
Checked, Done, Emailed — over 24 steps, `save-details` new. With the vendor "None" a run is
receive → extract → check-document → (verify-read) → save-details → notify, and calls
QuickBooks for nothing (`automations/invoice-processing/test/none-path.test.ts`). `find-accounts` reads the company's chart
with one query (the kit's `chartQuery()`), and `decide` picks from it (`automations/invoice-processing/src/decide/picks.ts`,
`automations/invoice-processing/test/picks.test.ts`): the category by the spend type's list of names, else its detail type,
else Uncategorized Expense; what a receipt or a refund was paid from — the card its printed
digits name, the only card, the only bank — else it waits for approval showing the first by
name. The second AI read runs only when the first shows a problem, or, with QuickBooks, over the
limit (decision 3; `automations/invoice-processing/test/second-read.test.ts`). A document QuickBooks cannot take — one of its
recording rules, or QuickBooks failing mid-run, a write it may have made included (decision 6,
through the SDK's `recover`) — never fails the run: its details are saved and the result says
"Saved. Not recorded in QuickBooks: …", or "Saved. QuickBooks didn't confirm. Check QuickBooks
before you run it again." Every word a person reads is the spec's (its §3.E and §3.F): timeline
lines of 80 characters at most, a one-sentence result, the run's `details` as label and value
lines, the same lines mailed, and no reason code anywhere (`automations/invoice-processing/test/words.test.ts`). The
manifest's additions and the result's `details` are the platform's #210 (ADR-0037), copied
into `contract/schemas/` from its branch before it merges (`contract/README.md`): until it
merges and is promoted, v2 cannot be registered. What follows describes v1, and what v2 keeps
of it; where they differ, this paragraph wins, and v3's above it.

**v1.** It was built in groups, each appending its steps to
`manifests/invoice-processing.v1.json`; v1 holds all 24 and was registered on 2026-10-12 (the
platform's #205, read back live by its #206), so that file is now immutable and a change to it
is a v2 (below). The first five steps spend nothing. `receive` holds the platform's
measurements of the upload — its real kind, its size, a PDF's pages, an image's pixels, taken
once when the upload was sealed — to the
owner's limits (a PDF, JPEG or PNG, measured as the type it declares; 3,500,000 bytes; 10
pages; 8,000 px a side), fails closed when one is missing, and never downloads the file;
`read-company` proves QuickBooks is connected and the company is in the US, and keeps
whether it runs QuickBooks Payroll; `read-preferences` keeps the home currency, the
multicurrency flag, the books' closing date and whether a vendor credit may carry its own
number; `find-accounts` resolves every account the flow's settings name — the default
category, Paid from, Owed to team members, Owner's investment account, each owner's own
account and one category per spend type — in one `FullyQualifiedName IN (…)` query, each
name beside the one QuickBooks gives an account it made inactive, "<name> (deleted)", so an
inactive account is said to be inactive and not missing; Intuit's IN compares an account's
names with case (sandbox S1), so a setting must match QuickBooks exactly, capitals included,
as its help in the manifest and its "No QuickBooks account matches" sentence say (the owner's
"Exact capitals, said clearly", 2026-10-12); each held to the kinds its role accepts and,
with multicurrency on, to USD, and before that query
fails the run on a "Company card's last four digits" filled in but not exactly four digits,
which would otherwise turn the card check off unseen; `find-payer`, when a
person switched on "I paid for this with my own money", finds who paid among the flow's
owners and partners, or as an employee in QuickBooks — an inactive one, found by the
"(deleted)" name QuickBooks gives it, failing as inactive — before anything is read. `extract`,
the first of its two model calls, sends ~~`automations/invoice-processing/prompts/extract-document.v1.json`~~ — 17 rules and a
27-field answer schema, 16 of its fields nullable — with a fixed task, `MODELS`
(`anthropic/claude-haiku-4.5`, then `google/gemini-3.1-flash-lite`) and the run's file by
its id; it starts no call with less than 260 seconds to the deadline, repeats one only when
nothing reached the platform, and passes the answer on whole in `state.extraction`, beside
`state.modelServed`, for the next step to check — its timeline line names the model and
counts, never a value. `check-document` (code only) cleans that answer once — text, whole
cents, real dates from 2000 on, ISO 4217 codes, a receipt's tip and card digits, a credit's
signs, a statement's rows — routes it (a bill, an expense from "Paid from", a card refund, a
vendor credit, a statement compared only, or what an employee, an owner or a contractor paid
personally), holds it to the 28 fail rules in the plan's order, each a fixed sentence, runs
the arithmetic in whole cents within 1¢, and keeps `state.document` with what decide is to
hold on; the raw answer leaves the state there. `verify-read`, the second model call, sends
~~`automations/invoice-processing/prompts/verify-document.v1.json`~~ — read 1's own definitions for the type and the 13 fields
that go into QuickBooks, 14 fields of which 8 nullable — blind to the first read, with
`excludeModelAuthors` set to the maker of the model that served it; without a maker to leave
out, or answered `no_model_left`, it is not made, never made without the exclusion. It
compares the fields the route writes, exact after the same cleaning and the seller roughly,
records the second total only when it alone adds up (and runs the arithmetic again), and
keeps `state.verification` for decide: a difference holds, a statement's disputed type fails
(F7), a second read not made holds; out of time and the platform's faults fail. Nine lookups
follow (steps 9–17), each ONE `query.run` per document type, as the plan's §5 table runs it,
or skipped (`automations/invoice-processing/src/lookups/queries.ts` builds every text, and fixed-text tests hold each):
`find-vendor` and `find-vendor-company` find the seller — or the contractor who paid — by the
exact name and the "<name> (deleted)" QuickBooks gives a vendor it made inactive (sandbox
G4–5), so an inactive vendor is never taken for a new one, then by company name, which
QuickBooks leaves as it was, active or not, each row re-checked in code (an inactive
vendor fails "reactivate it" and two fail — but a company receipt's or a card refund's seller,
looked up only to link an existing vendor (D20), is then not linked: no payee, its line saying
why — and a person nobody has is V1); for a bill's new vendor, `find-similar-vendors` lists up
to three vendors with its distinctive word for the approver, inactive ones shown by the name
they had and marked once, and
`find-customer-name` and `find-employee-name` check the name is free (employees a connection
cannot read go on as unreadable — sandbox S7); then `find-duplicate-number`,
`find-duplicate-amount`, `find-related` and `find-other-record` gather the records decide
weighs — a number QuickBooks could not hold (none, or over 21 characters: the document's own,
a credit's original invoice number, every one a statement lists) says "Not checked" and is
never sent, a full answer is a possible duplicate (D6) whose line always keeps "maybe more",
a statement's listed invoice numbers — each once, whatever its case, one past 21 characters
counted as not in QuickBooks — and open bills are this vendor's, and a statement's lookup
QuickBooks refuses ends "Compare the statement in QuickBooks". The bank-feed check (D21) searches
expenses by amount in its window: `EXPENSE_SEARCH` is `'amount'` (`automations/invoice-processing/src/lookups/expense-search.ts`),
because sandbox S4 answered on 2026-10-12 that Intuit filters `TotalAmt =` within a date range;
the plan's fallback, `'window'` — the window alone, newest first, 50 at most, a bill's D32 check
dropped — stays in the code, run only by the suites. `decide` (`src/decide/`, step 18) makes
one result: a fixed sentence, one hold with every reason (the SDK's held outcome, an approval
resuming after it), a statement
compared, or the record planned; its whole input is `automations/invoice-processing/src/decide/contract.ts`, and the
lookups and decide share one table of which lookups run (`lookupUses`,
`automations/invoice-processing/src/decide/lookup-uses.ts`). What decide saves — the record planned, the re-check an approval
repeats, the company it checked — is the ONLY input of the six steps after it (24 of the 24 the
platform allows): an approval resumes at `confirm-company`, which compares the company's names,
country and file creation time with QuickBooks' again; `confirm-vendor` looks a new vendor up
again by the name it would get, and links one added while the run waited; `create-vendor` adds it
as the approver saw it named, a lost answer repeated as create-record's is (below); `confirm-no-duplicate` repeats the path's own duplicate lookup —
the very query, one row more and the newest created first (`ORDERBY MetaData.CreateTime DESC`,
which Intuit applies before the bound: sandbox G4–5), so a copy made while the run waited is
never past it, by the document's number only when the record will carry it, else by
its total and date — and fails on a matching record added while the run waited ("A matching
record was added in QuickBooks while this waited for approval, possibly from your bank feed."),
by the one rule decide holds on (`automations/invoice-processing/src/decide/duplicate-rule.ts`): one the approver never saw,
unless decide's lookup was full and QuickBooks created it before that answer, which the approved
"too many to check" covered; a first run skips all four. `create-record` then makes the one
record — a bill, an expense, a refund to the card, a vendor credit or a journal entry, through
the platform's `bill.create`, `purchase.create`,
`vendorCredit.create` or `journalEntry.create`, each with its `requestid` — from the saved plan
alone, never the settings as they are by then, its memo naming the run that wrote it (after an
approval the continuation); a lost answer, or a 502/503/504 naming no reason, repeated by the
step's retry under the same key, so the same `requestid`, which QuickBooks answers with the
first record and never a second (sandbox S6) — and, once the attempts are spent, for
QuickBooks' own 429 or 5xx or Fault 600, or for any refusal of a repeat (the attempt that went
unanswered may have made the record), "did not confirm" — and each Intuit code the plan maps
(6140, 6240, 610, 2500, 6190, 6200, 6210, 2050, 2290, 2300, 6430) has its own sentence. Its line,
which is also the run's summary, says what was recorded and the next step — "When this charge
arrives in your bank feed, choose Match, not Add" for a receipt or a refund, how an employee, a
contractor or an owner is repaid. `notify` mails a plain-text summary, built from QuickBooks'
answer — the document's number on its line, "in the memo" when the record was not sent it, and
the number QuickBooks gave an expense or a credit itself on its own — to the optional "Also email"
address — a statement's counts and what QuickBooks shows open — and is skipped when it is empty;
a mail that fails never fails the run. The run's result (`automations/invoice-processing/src/output.ts`, described by the
manifest's `outputSchema`, which the tests hold every output
to with Ajv) is the record made — its type and QuickBooks Id, payment type, payee, payer, Paid
from account, the next step, why it was held — or a statement's comparison with the full list of
the invoice numbers it lists that QuickBooks lacks.
Every failure ends the run with a fixed sentence, a run that ends on a thrown error
included — never the error's message; once the record exists, a run that cannot finish (the
platform refusing a step's report, say) names it and says to check QuickBooks before running
it again, never "run it again in a few minutes". The measurements — `measuredKind`, `pageCount`,
`widthPixels`, `heightPixels` — are copied into the SDK's `ArtifactReference` from the
platform's pull request before it merged (its BUILD-PLAN 25.2.28, merged unchanged as its
`main` `7086e5e`), and `measurementsOf` in `automations/invoice-processing/src/file.ts` is the one place that reads them;
the manifest declares the page and pixel limits, without which the platform measures
nothing.

Its tests need no model key. `test/samples/` holds 25 made-up documents — bills (typed,
scanned, photographed, a portal screenshot, hand-printed, 300 lines, a utility bill with an
earlier balance, one whose largest print is its account number), receipts (a till roll, a
store receipt and a fuel slip photographed, restaurant receipts with a tip and total
written in and with a tip under a printed total, a card slip with only a tip written in, a
hand-written cash receipt, a 60-line thermal roll at 2,576 px, cash back, an invoice
stamped PAID), a credit memo, a refund to a card, a supplier statement, a card statement,
two invoices in one file, a page missing, and instructions to the model printed on one —
each drawn by `test/sample-maker/` beside its `expected.json`, with a marker printed in a
line's text or a notes box, never in the seller's name or the document number, that no
answer, timeline line or reason may carry; `npm run samples` (in the automation) makes them
again and rewrites a file only when what it draws changes. Each sample is recorded twice, by
two agents blind to each other: read 1 — an agent acting as the model, given exactly what
`npm run recording-request` prints for a sample — in
`test/recordings/extract-document.v1/<sample>.json`, and read 2, given what
`npm run recording-request -- --read 2` prints, in `test/recordings/verify-document.v1/`;
the loader refuses one made for another prompt or version, or other prompt or sample bytes.
All 50 are recorded — read 1 by agents on `claude-opus-5-5`, read 2 on `claude-sonnet-5-5`,
each given only its read's request and the document under a neutral file name — and the tests
over them run each pair through steps 1–8 with the model answering as recorded, check-document,
read 2's comparison and decide (the vendor matched, nothing found): the sample's marker reaches
no line, sentence, reason or saved data. `automations/invoice-processing/test/planted-marker.test.ts` plants each marker in
every field the code reads but never passes on — read 1's currency, card digits, dates and
listed references (not a statement's, which are carried), read 2's currency, card digits and
dates — on every path, held and straight through — and `automations/invoice-processing/test/writes-marker.test.ts` takes each
sample's marker through every step on the simulator, approved when it held: no QuickBooks
request, mail, line or result carries it.

## Candidate reviewer

`candidate-reviewer` — **Resume Screening** from v2 (**Candidate Reviewer** at v1), in HR — reads a
job description once into the job's reading, then reads each candidate's resume and scores it
against that reading (the platform's BUILD-PLAN Phase 28, Round 19). It is the first flow with
items ("A flow's items", above): a job is its item, a candidate its run. What it does, in the words
a person reads — what v2 changed (its [top](automations/candidate-reviewer/README.md)), the
departments ([§2](automations/candidate-reviewer/README.md#2-how-it-starts)), the prompts and what
they read ([§4](automations/candidate-reviewer/README.md#4-ai-steps)), the steps ([§6](automations/candidate-reviewer/README.md#6-steps-a-person-sees)), the title,
score bands, verdict, summary and sections in their order ([§7](automations/candidate-reviewer/README.md#7-what-a-run-gives)), and every
failure's sentence ([§8](automations/candidate-reviewer/README.md#8-when-it-fails)) — is its spec,
[automations/candidate-reviewer/README.md](automations/candidate-reviewer/README.md), the build's source of truth word for word.
Where the code does it:

- **v2, the version this code serves**: `SERVED_VERSIONS` in
  `automations/candidate-reviewer/src/automation.ts`, whose `servedManifests` keeps it alone of the
  manifests `define` is given and refuses when none is left, as Invoice Processing's does; its
  Dockerfile copies only `manifests/candidate-reviewer.v2.json`, which `automations/candidate-reviewer/test/manifest.test.ts`
  holds to the spec and the code's constants to (the file types and size in
  `automations/candidate-reviewer/src/file.ts`, the two file keys), and to v1's
  `manifests/candidate-reviewer.v1.json` but for what v2 changed — its job's reading v1's. v1's
  container keeps its pinned image until it is retired.
- **A job** — the item run, `items.pipeline` (`job-received`, `read-job`, `save-job`):
  `automations/candidate-reviewer/src/steps/job.ts`. The reading is `extract-posting`'s answer,
  cleaned (`automations/candidate-reviewer/src/reading.ts`), the item run's output held to the
  manifest's `items.outputSchema`; its sections are `postingSections` in
  `automations/candidate-reviewer/src/sections.ts`.
- **A candidate** — `pipeline` (`receive`, `read-resume`, `check-resume`, `score`, `save`):
  `automations/candidate-reviewer/src/steps/candidate.ts`. `scored` there is what the scoring call
  reads: the resume without the fields §4 leaves out, and without any line quoting a direction the
  resume printed to its reader, which is sent apart. The years are worked out in
  `automations/candidate-reviewer/src/years.ts` (overlapping roles once, a current role to today);
  the score, its flags — "years not shown", and each direction — and the requirements a direction
  was quoted for, moved from met to missing, in `automations/candidate-reviewer/src/scoring.ts`;
  the sections in `candidateSections`; the verdict, from the score alone at one constant
  (`ADVANCE_FROM_SCORE`, `verdictOf` in `automations/candidate-reviewer/src/words.ts`), on a
  candidate's run and never on a job's. A model's refusal of the file (its type, size, bytes or
  password) is "could not be read" (`readDocument` in
  `automations/candidate-reviewer/src/prompts.ts`); any other refusal ends the run in the
  platform's words.
- **Directions planted in a document**: each of the three prompts reads its document as content,
  never as instructions to it; `extract-resume` copies what tries to direct its reader into
  `directions`, which the code keeps out of what the score judges and flags
  (`automations/candidate-reviewer/test/candidate.test.ts` plants one).
- **Word files** (`automations/candidate-reviewer/src/docx.ts`): Node's `zlib` alone, no
  dependency. `word/document.xml` and the page headers and footers (`word/header<n>.xml`,
  `word/footer<n>.xml`, read first) are found through the ZIP's central directory; their text
  comes from `w:t`, their lines from `w:p`, with tabs and breaks. Entries that together claim more
  than 5 MB inflated, any with a ratio over 100, an encrypted one or one not stored with deflate
  are refused before anything is inflated, and each inflation stops at the size its entry claims;
  a refused file could not be read, and nothing is spent on it.
- **The file's own links** ([§4](automations/candidate-reviewer/README.md#4-ai-steps); build 28's
  F8): `readResumeFile` in `automations/candidate-reviewer/src/file.ts`, for a candidate's file
  only, reads them — a PDF's with `pdfLinks` (`automations/candidate-reviewer/src/pdf.ts`, held to
  its `PDF_LIMITS`), a Word file's with `docxLinks` (`automations/candidate-reviewer/src/docx.ts`,
  through the same directory and `DOCX_LIMITS` as its text). `fileLinks` and `withFileLinks` in
  `automations/candidate-reviewer/src/reading.ts` keep and add them as §4 says, a link only the
  file gave named by `linkLabel` (`automations/candidate-reviewer/src/words.ts`).
- **Models and retries**: Invoice Processing's two models ("Pick a model"), `MODELS` in
  `automations/candidate-reviewer/src/prompts.ts`; no step declares a retry (§6).

The platform side is a finding for its session (the `new-automation-version` skill's step 5): the
manifest's pull request, the image pin and the container's alias, once CI publishes the image on
`main`, after the platform's build 28 contract ([contract/README.md](contract/README.md)).

## The kit

`packages/automation-kit` (`@autom8x/automation-kit`) is a library automations build
with — the owner's decision of 2026-10-10: "should we create a library folder that
specific automation folders call to build with". An automation depends on it by
`file:` as it depends on the SDK, and its Dockerfile builds it and packs it into the
image with `--install-links`, so every image carries its own copy and nothing is shared
at run time (platform ADR-0034 decision 6; `test/isolation.test.ts` allows an automation
the SDK and the packages under `packages/`, never another automation). It runs on Node
built-ins alone, reaches the platform only through the SDK types it is handed, and holds
only what an automation here uses:

- `@autom8x/automation-kit/quickbooks` — `readQuickBooks`, one QuickBooks READ through
  the step's `callProvider`. QuickBooks' own 429, inside a successful callback, waits 60
  seconds and asks again, at most twice and only while five minutes of the run would
  remain; a 5xx asks again once; then, and for a 408 or 425, QuickBooks is busy. A 401,
  a 403, no live connection, a missing scope and the platform's other refusals with a
  cause end with a fixed sentence (`QUICKBOOKS_SENTENCES`); a Fault is named by its
  number alone; any other failure is thrown on unchanged, so the SDK's step retry can
  repeat it. The waits use an injected `Clock`, so a suite never waits a minute. Reads
  only: a repeated write could create a second record. Beside it, `writeQuickBooks` —
  one WRITE of a bill, an expense, a vendor credit, a journal entry or a vendor, one request
  a call, the request id left to the platform: no answer, or a 502/503/504 naming no reason,
  is thrown on unchanged for the step's retry, whose repeat goes out under the same key and
  so the same `requestid`, which QuickBooks answers with the first record (sandbox S6); any
  other failure says whether a record may exist, in a fixed sentence — no record was
  created, or QuickBooks did not confirm it — with a Fault named by its number, and once an
  attempt was thrown on, no later attempt's answer says no record was created: a refusal of
  the repeat, the platform's or QuickBooks', says QuickBooks did not confirm it, naming what
  the repeat was answered (the attempts of a step share the one platform object the runner
  hands it, against which the write notes an attempt it threw on);
  `withDeletedForm`, `rowsNaming` and `unmarkedName` for the "<name> (deleted)" QuickBooks
  gives a vendor, an employee or an account it made inactive (sandbox G4–5); the query
  text — `lookupQuery`, `lookupInQuery` and
  `lookupLikeQuery` (one word of letters and digits, `LIKE '%word%'`) for a name list,
  active or not, and `transactionQuery` with `dateRange` for bills, expenses, vendor
  credits and journal entries, conditions joined by AND, no Active condition, ordered by a
  plain field or by `MetaData.CreateTime`, each value quoted with every backslash written
  four times — Intuit reads a value's escapes twice (sandbox G4–5) — then every apostrophe
  escaped, `%` and `_` left as themselves, which they are under `=` and IN — `chartQuery()`,
  the one chart read v2 of `invoice-processing` makes (every active Bank, Credit Card,
  Expense, Other Expense and Cost of Goods Sold account, at most 1,000; its IN on
  `AccountType` is sandbox read S13, still to be made), and readers for Intuit's answers
  (`entityOf`, `queryRowsOf`, `nameValueOf`).
- `@autom8x/automation-kit/values` — the one cleaning of a value read from a document:
  `cleanText`, `toCents` (whole cents, a fraction of a cent rounded half away from zero and
  marked), `queryAmount` (cents as a query's `1250.00`), `parseDate` (a real day from 2000
  on), `cleanCurrency` against ISO 4217 List One
  of 2026-09-17 (155 codes), `formatMoney`, `fitLine` and `fitReasonLine` (a line of at most
  200 characters, names shortened first with '…'; `phrasesKept` says how many phrases a reason
  line keeps before '+N more'), and the receipt and credit rules: `cardDigits`, `tipRule`,
  `creditSignRule`.
- `@autom8x/automation-kit/testing` — `QuickBooksSimulator`, plugged in as
  `RecordingPlatform.provider`: QuickBooks answering from a made-up company, behind
  Connections' rules — a final answer replayed for the same request under its key, a
  different request under a used key refused 409, nothing recorded for a 5xx, 401, 403,
  408, 425 or 429, an answer over 192 KiB a 502 naming no reason, an input naming
  `accountId` refused, and — as the platform's `4807959` refuses it (its BUILD-PLAN 25.2.33) — a
  write naming `Id`, `SyncToken` or `sparse` at the top level, in any case, refused 400
  `refused_field` before anything is written (`REFUSED_BODY_FIELDS`). A suite can script an
  answer lost after QuickBooks acted, recorded first or not; QuickBooks answers a create
  repeated under the same request id — for one company, the same operation and key — with
  its first answer, as sandbox S6 found. Its company holds accounts, employees, vendors, customers, bills,
  expenses, vendor credits and journal entries (a `sample…` builder for each): it answers
  only the query text the kit's builders write, by Intuit's documented rules (IN, =, <, >,
  <=, >= and LIKE joined by AND, OR refused; filterable and sortable fields from Intuit's
  model file; an expense's amount behind a switch; `chartQuery()`'s text answered with its
  active accounts of those types, which include Uncategorized Expense, two banks and two
  cards, one named "Visa 4417", and one account per v2 name list) and as Intuit's sandbox
  answered (a
  value's escapes read twice, IN on an account's names compared with case, and `ORDERBY
MetaData.CreateTime` on every transaction), and
  creates a vendor, a bill, an expense, a vendor credit or a journal entry as Intuit
  documents — an expense or a vendor credit sent no number numbered by QuickBooks itself, the
  last number plus 1, when the company's own numbers are off — each kept for the queries after
  it. It throws each refusal through the SDK's `refusalFixture`,
  which the suite hands it, so the kit imports nothing at run time.

## Adding an automation

A new flow starts from the owner's idea, written down as a spec the owner approves, words
included, before any code: `/create-flow`, the shared kit's skill
(`snoopy-backend/.claude/skills/create-flow/`, installed to the workspace and run from there, the
platform's BUILD-PLAN 28.2.5), whose spec becomes `automations/<templateId>/README.md`. Its build
is the steps below.

1. Copy `templates/automation` to `automations/<templateId>` and replace `example`
   with your templateId everywhere (`package.json`, `Dockerfile`, `src/`). Give it a
   lockfile: copy an existing automation's `package-lock.json` and change its two
   `name` fields, then run `npm install --package-lock-only --ignore-scripts` at the
   root so the root lock learns the workspace. Write the steps; keep prompts in
   `prompts/`. To build with the kit, depend on it by `file:../../packages/automation-kit`
   as on the SDK, pin it beside the SDK in the automation's lockfile, and build and pack
   it in the Dockerfile as the SDK is — `invoice-processing` shows all three.
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
   its `snoopy-backend/deploy/compose.prod.yml`. There is no registration endpoint, and the
   platform's ADR-0020 decided there will not be one: `service.origin` is where
   customer documents get sent, review is the authorization, and a pull request is
   the only write path that carries one. The rules a manifest must meet beyond the
   schema are in `contract/README.md`, in the validator's own words.
6. Declare the origin as `http://<templateId>-v<n>.autom8x.internal:8080`, and a
   service account of its own for each version: one container per manifest version for
   everything new (the platform's D2), and its `snoopy-backend/scripts/add-automation.mjs` refuses any
   other origin. The platform gives that version's container the name as a network
   alias, so it is reachable only on the compose network by construction.

A registered manifest at a version is **immutable.** Changing anything means a new
file at `v<n+1>` — a run pinned to v1 must still resolve the service it actually
called. The platform's decision of 2026-10-08 (D2) is one container and one image
per manifest version.

## Working here

```bash
npm ci --ignore-scripts
npm run verify        # the whole gate, its steps listed once in CLAUDE.md ("Gates and push");
                      # its last step re-emits docs/repo-facts/snoopy-automations.json with the gate's claim
npm run facts         # re-emits the facts file without the claim, after adding or removing files
```

Node 22 or newer. Agent sessions read `CLAUDE.md` first. The committed facts file
is held to the tree by `test/repo-facts.test.ts`: when its counts go stale, run
`npm run facts`, then `npm run verify`, and commit the file.
