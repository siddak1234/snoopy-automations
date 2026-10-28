# snoopy-automations

Autom8x automations — the logic that runs when a workspace's automation fires. Each
one is a small service the platform calls, which calls back. **This repository's files
hold no secret and never will:** an automation receives a run-scoped token at runtime and
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
contract/schemas/            the wire contract — JSON Schemas vendored from the platform, and its menu
packages/automation-sdk/     the step runner, prompt modules, the six callbacks, the serving shell, test doubles
packages/automation-kit/     a library automations build with: QuickBooks calls, value cleaning, a QuickBooks simulator
automations/<name>/          one automation per directory, with its own Dockerfile and lockfile
templates/automation/        the template directory: a worked flow on defineFlow, tested by the gate, which the scaffold builds from
manifests/<name>.v<n>.json   what the platform registers, validated here first and shipped in the image
scripts/scaffold.mjs         npm run scaffold -- <id>: a new flow's frame from its manifest and spec
scripts/review-rows.ts       the review checklist's machine rows, posted by CI
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
recorded in QuickBooks" and save the details instead (its
[README](automations/invoice-processing/README.md)); `undefined` lets the run fail as before.

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

**What a person reads, as blocks** (the platform's ADR-0048, Round 21, and its amendment 1, block
set v2). A success's `result`, or a `held()` step, may return `blocks` of the twelve types an
automation may send — text, metric, badge, table, list, section, file (one of the job's uploads),
link, timeline, image (one of the job's files, drawn as a picture), chart (bar or line) and group
(one card of drop-down sections) — which the platform draws in the order sent, in the `result` part
of the run's page (on an item run, as the item's reading). The manifest's `display.pages` orders the
page's parts (`PAGE_PARTS`; the item page's `scores` is opt-in); a flow that declares none is drawn
in today's order. An image's file is drawn inline only when its upload declares a page or pixel
limit, so the platform measures it; otherwise it is a file row. The types are
`packages/automation-sdk/src/block-types.ts`; `boundedBlocks` (`packages/automation-sdk/src/blocks.ts`,
at `BLOCK_LIMITS` in `packages/automation-sdk/src/blocks-limits.ts`, the platform's numbers) cuts each
string whole at its bound and leaves out what the platform would refuse, rather than the whole
result being refused. `boundedResult` applies it to every result it sends, and refuses `blocks`
beside `sections` or `details` before sending, as the platform does. The limits and what is
refused, in the platform's words:
[contract/README.md](contract/README.md#what-the-platform-refuses-beyond-the-schema), "A result's
blocks". The template sends its readout this way (`templates/automation/src/automation.ts`).

## A new flow's standards (`defineFlow`)

Every flow built from Round 21 on is defined with `defineFlow` (`packages/automation-sdk/src/flow.ts`):
`defineAutomation` with the standards on, so every new flow fails, retries and words its failures
the same way, by reuse rather than by each flow writing its own (the two live flows did: Invoice
Processing's `noteThrows`, Resume Screening's `stops`). `npm run scaffold` and the template use it.
**The two live flows keep `defineAutomation`, unchanged**, until their after-pilot versions
(Invoice Processing v8, Resume Screening v3); `defineAutomation`'s behaviour is as before.

- **A throw never reaches a person.** A step that threw until its attempts were spent ends the run
  with the flow's own sentence for that step (`sentences`) or the SDK's (`FLOW_WORDS`,
  `packages/automation-sdk/src/words.ts`), never `error.message`; the log keeps the error's name,
  status, code and reason. `failed(sentence, code?)` ends a step with a sentence people read and a
  code only the log keeps.
- **`settle(context, () => call)`** (`packages/automation-sdk/src/settle.ts`) is the one way for a
  risky call: `{ ok: true, value }` or `{ ok: false, kind, sentence }`, the kind one of
  `not_connected` (Connections' 404), `not_declared` (403 `provider_not_declared`),
  `vendor_refused`, `vendor_down`, `unconfirmed`, `unanswered`, `ai_refused` and `timeout`, a
  provider's own non-2xx inside a 200 included. A typed model refusal's sentence says what a person
  can do: the month's allowance used up (`over_plan_limit`), AI not set up for the flow
  (`capability_not_in_plan`, `entitlements_not_configured`, `no_model_left`), an answer too long
  (`truncated`), else a clearer file. It works with the step retry, not around it: `defineFlow` gives
  each attempt's context `retryLeft(error)`, true while the runner would run the step again (its
  policy repeats the error, a wait remains, the next attempt starts before the deadline), and
  `settle` rethrows while it is true, so a 502 is retried before it is `unconfirmed`. **Once an
  attempt has had a model answer, `retryLeft` is false**: a re-ask that then gets no answer ends as
  `unanswered`, and the billed first call is never made again.
- **Never "Try again" once an app may have done something.** A provider call nothing answered — no
  answer, a timeout, a 502/503/504 that decided nothing — that did not provably never leave
  (`isUnsent`) is `unconfirmed`: "The connected app didn't confirm this. Check it before you run this
  again." A re-run carries a new run's key, so it would do the write again (the template's `act`
  says why). `defineFlow` notes per run when a provider call has answered 2xx or was unconfirmed;
  once noted, a step's throw or a report the platform refuses ends the run "Something went wrong
  after a connected app was used. Check it before you run this again." (Invoice Processing's
  `RunNotes`, generalised.)
- **The log says what each standard did.** Each attempt's context carries `log`, with the run's and
  the step's ids on every line: `settled` (the kind and the error's name, status, code and reason),
  `model_reasked` (Q2's or 5d's reason, the schema's `path` and `rule`) and `not_connected` (the
  provider's id) — so a flow re-asked every run, or going on without a connection, shows it.
- **An optional connection**: `optionalConnection(context, key, providerId)` reads the setup
  field's choice from the step's context. Not chosen, the step returns `skipped`; chosen and
  `not_connected`, its `notConnected(displayName)` goes on with "Not sent to X: X isn't connected" and
  no failure reason.
  A required connection needs nothing here: the platform refuses going live (422) and a run (409)
  without it, and the clients say "Connect X first."
- **Q1, the exact-quote check**: `quotesIn(documentText, values)` names each value whose exact
  words are not in the document; the template's `review` holds those for a person.
- **Q2**: an answer off its schema (`output_schema_mismatch`) is asked once more with the same
  registered prompt and one fixed line naming the schema's `path` and `rule`; a second miss holds the
  run for a person ("The AI's answer needs a person to check it.", the state's `unmatchedAnswer` the
  step's id). **One to three more paid AI calls**: the platform tries the request's next model on a
  miss too, each a `runs.model_calls` row against the plan's allowance.
- **5d**: a call asks at the owner's cap (the menu's `limits.modelAnswerTokens`) unless the step names a lower
  `maxOutputTokens`, which only a flow's spec sets; one cut off (`truncated`) below the cap is asked
  once more at the cap — **one to three more paid AI calls** — and one cut off at the cap is not
  asked again: it ends "The AI's answer was too long to finish. Try a shorter file." One re-ask per
  call at most, for either reason.
- **5a**: the waits between a step's attempts are spread upward by up to half of each, never under
  the 10-second floor and never past the 30-second cap (`spreadWaits`, `retry.ts`); at three attempts
  there is no room, so the waits stay 10 and 20 seconds.
- **The shared failure drill**: `failureDrill(automation, fixture)` from
  `@autom8x/automation-sdk/testing` (`packages/automation-sdk/src/drill.ts`) runs the flow once per
  case — a missing connection (404, then `provider_not_declared`), the vendor down (502, then no
  answer, then no answer from the app alone), a malformed AI answer twice (which must end held), a
  timeout, and a report the platform refuses once the app answered — and fails on a throw, a raw
  message, words in neither `FLOW_WORDS` nor the flow's spec and `words.md`, or "Try again" in the
  two cases where the app may have done it. Every new flow's
  `automations/<id>/test/drill.test.ts` runs it, and `test/conformance.test.ts` fails a flow without one, the two live
  flows exempt by name.

What a flow's code may reach is enforced too: `test/network.test.ts` fails a `fetch(`, Node's
network modules, `undici` or a vendor SDK under `automations/*/src` (CLAUDE.md rule 4), and
`test/menu.test.ts` an integration or operation the menu does not offer ("Build a flow", below).

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

**An enum value in another case is the schema's value** (the platform's Round 21, 5c, for every
flow): the platform accepts "Bill" for an enum of `bill` and hands the automation the completion
with the schema's own spelling, so an exact `case 'bill'` takes its branch; an enum holding two
values equal ignoring case keeps exact matching. `RecordingPlatform` converts the same way, with a
copy of the platform's rule (`respellEnums`, `packages/automation-sdk/src/output-schema.ts`). And a
request may ask for a smaller answer than the owner's cap: `maxOutputTokens`, a whole number from 1
to the cap (the menu's `limits.modelAnswerTokens`; `ModelCallOptions.maxOutputTokens`); left out,
the platform sends its cap.

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

## The flows

Each flow's spec and build record is its own README, which a change to its code, prompts or
manifests updates in the same change (`docs/docs-map.json`, its "automations" and "manifests" rules,
a `*` bound to the flow's id):

- **Invoice Processing**, `invoice-processing` (v7):
  [automations/invoice-processing/README.md](automations/invoice-processing/README.md).
- **Resume Screening**, `candidate-reviewer` (v2; Candidate Reviewer at v1): its spec,
  [automations/candidate-reviewer/README.md](automations/candidate-reviewer/README.md), and how the
  code does it, at its end.

Both are live on `defineAutomation`, and their code, prompts and manifests are unchanged until their
after-pilot versions (Invoice Processing v8, Resume Screening v3) move them to `defineFlow`
("Build a flow", below).

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

## Build a flow

A developer needs this repository alone: no backend checkout (CLAUDE.md, "Start here").

1. **`/create-flow`** with the idea ([.claude/skills/create-flow/](.claude/skills/create-flow/SKILL.md)).
   It checks the idea against **the menu**, `contract/schemas/platform-menu.json` — every block, page
   part, question form, setup control, trigger, capability, integration with its operations, and
   limit a flow may use, generated by the platform ([contract/README.md](contract/README.md)) — and
   says which it is: **one pull request** here; **two**, when it needs a vendor or an operation the
   menu lacks (one provider file in `snoopy-backend` first, with every console step for the owner at
   once: `.claude/skills/create-flow/templates/provider-pr.md`); or **stop**, a platform change. It writes the
   spec, `automations/<id>/README.md`, and `words.md` for the owner's approval.
2. **Write `manifests/<id>.v1.json`** from the spec's sections 1–3 and 5–7, then
   **`npm run scaffold -- <id>`** (`scripts/scaffold.mjs`): the folder from `templates/automation/`,
   its lockfile and the root lock's entry, `automations/<id>/src/automation.ts` on `defineFlow`, one typed stub per
   step (`src/steps/<step>.ts`, "Not built yet"), one prompt stub per capability, one `test.todo` per
   §9 row and `automations/<id>/test/drill.test.ts`. It never overwrites a file, so it is safe to run again.
3. **Write the steps, the prompts and the tests**: each risky call through `settle`, each failure
   through `failed` in the spec's §8 words, what a person reads as blocks through `boundedBlocks`
   ("A new flow's standards", above), each §9 row a test shown to fail without its code. To build
   with the kit, depend on it by `file:../../packages/automation-kit` as on the SDK, pin it beside
   the SDK in the flow's lockfile, and build and pack it in the Dockerfile as the SDK is —
   `invoice-processing` shows all three.
4. **`npm test`**, then `npm run map` and `npm run facts`, then the gate (CLAUDE.md, "Gates and
   push"). Open the pull request: it is the flow's folder, its manifest and three generated files,
   which `.gitattributes` folds. CI's **Review rows** (`scripts/review-rows.ts`) answers the checklist
   rows a machine can — §3 the menu, §4 the capabilities, §6 the steps, §7 the blocks, §8 the
   failure words, §9 the tests, the paths and the drill — and a FAIL row fails Verify; a person reads
   the rest (`.github/pull_request_template.md`). On a pull request, Image builds only the flows whose
   image inputs changed (`scripts/changed-images.mjs`).
5. **The merge is the deploy** (the platform's ADR-0047): CI's Deploy job starts the platform's Flow
   CD with the merge commit, which checks the commit, the image's attestation and the manifest, runs
   its validator and its **readiness check** before any container starts — every integration the
   manifest declares has a provider file, and every OAuth one has keys on the servers, or the version
   is refused ("not live: needs QuickBooks keys on the servers (PROVIDER_CREDENTIALS)") and nothing
   it serves changes — then starts the version on both hosts, smoke-tests it and registers it. Read
   the Deploy job's summary: each flow shows NEW, UPDATE, SKIP, SUPERSEDED or REFUSED.

**Every new flow's merge redeploys the live flows too.** The root `package-lock.json` is an input of
every flow's image (each Dockerfile copies it), the scaffold adds the new workspace to it, and Flow CD
redeploys a served version whose inputs changed as an UPDATE. So each new flow's merge also restarts
Invoice Processing and Resume Screening at their versions, with no change in what they do: each
UPDATE is smoke-tested and the version it replaces keeps serving until it passes, and each passes the
readiness check again. A REFUSED row for another flow is not the new flow's: its code says what the
platform lacks (Invoice Processing's QuickBooks keys, for one), the owner's step, and re-running the
Deploy job once it is fixed serves it. Locks per flow, so that one flow's merge leaves the others
alone, are the platform's follow-up (its SYSTEM-MANIFEST §12.1 #314); the image inputs are unchanged.

Each version's origin is `http://<templateId>-v<n>.autom8x.internal:8080`, with a service account
of its own: one container per manifest version for everything new (the platform's D2), and the
platform's validator (`snoopy-backend/apps/catalog/src/check-manifest.ts`) refuses any other origin
or account. Each version runs as its own project on the platform's flow network, which gives it the
name as an alias, so it is reachable only there by construction. A new version `v<n>` of a flow
declares `SERVED_VERSIONS = [<n>]` in `automations/<templateId>/src/automation.ts`
(`/new-automation-version`, step 1). The rules a manifest must meet beyond the schema are in
`contract/README.md`, in the validator's own words.

A registered manifest at a version is **immutable.** Changing anything means a new
file at `v<n+1>` — a run pinned to v1 must still resolve the service it actually
called; `test/manifest-immutable.test.ts` fails when a file under `manifests/` that is on
`main` is edited or deleted. The platform's decision of 2026-10-08 (D2) is one container
and one image per manifest version: `test/conformance.test.ts` holds every Dockerfile,
the template's included, to copying exactly one `manifests/<templateId>.v<n>.json`, the
version its code serves.

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
