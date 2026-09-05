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

| It calls back to `callbackOrigin`         | Meaning                                      |
| ----------------------------------------- | -------------------------------------------- |
| `POST /v1/automations/callbacks/step`     | Progress on one declared step                |
| `POST /v1/automations/callbacks/result`   | The final outcome: success, held, or failed  |
| `POST /v1/automations/callbacks/model`    | Ask the platform to make a model call        |
| `POST /v1/automations/callbacks/provider` | Ask the platform to call a provider          |
| `POST /v1/automations/callbacks/artifact` | Read a file this run was given, by reference |

Every callback carries `Authorization: Bearer <runToken>` and nothing else. The
token arrives in the invoke, is scoped to that one run, bound to its workspace,
limited to its pinned manifest version, and expires with the run. The platform
checks all four on every callback.

Three rules follow, and the tests enforce them:

- **A held run ends.** `held` is not a pause: the automation returns its state and
  exits, and an approval starts a new run carrying that state back.
- **A step is reported only under an id the manifest declares.** The platform
  refuses any other and does not store it.
- **A summary never carries the document it describes.** Timelines are read by
  people and retained far longer than a run.

## Layout

```
contract/schemas/            the wire contract — JSON Schemas vendored from the platform
packages/automation-sdk/     the five callbacks, the serving shell, and test doubles
automations/<name>/          one automation per directory, with its own Dockerfile
manifests/<name>.v<n>.json   what the platform registers, validated here first
test/architecture.test.ts    the boundary, enforced
```

The boundary is the **wire format, not a package.** Nothing here depends on the
platform's TypeScript packages, because a third-party automation could not either.
`contract/README.md` says which platform commit the schemas were taken from.

## What an automation looks like

```ts
import {
  serve,
  type AutomationPlatform,
  type InvokeRequest,
  type RunResult,
} from '@autom8x/automation-sdk';

async function execute(request: InvokeRequest, platform: AutomationPlatform): Promise<RunResult> {
  await platform.reportStep({
    runId: request.runId,
    stepId: 'receive',
    outcome: 'ok',
    summary: 'Received',
  });
  return { outcome: 'success', summary: 'Done' };
}

await serve({ templateId: 'my-automation', execute });
```

The shell answers the probe, acknowledges an invoke before working, refuses above
capacity or while draining, reports the result (or the failure) for you, and logs
ids and outcomes only — an error's message becomes the run's `failureReason`, so
never build one from the document. `platform` is the five callbacks, each carrying
the run token, plus the one fetch that carries nothing: the bytes behind a signed
link. A test hands `execute()` a `RecordingPlatform` from
`@autom8x/automation-sdk/testing` instead.

## Invoice intake

`invoice-intake` is the first automation in this repository. A verified webhook
delivery carrying `vendor`, `amount`, and `reference` starts it. The platform wraps
that JSON in the invoke envelope, deduplicates the delivery, and supplies the
run-scoped token; the automation implements none of that ingress itself.

The subscription configures an approval threshold and a notification address.
Invoices above the threshold end their first run held, then resume from returned
state only after approval. The outcome mail is sent through the workspace's Google
connection and requires exactly `gmail.send`; there is no model callback. The mail
builder RFC 2047-encodes its UTF-8 Subject and declares the body charset.

## Adding an automation

1. Copy an existing directory under `automations/` and rename it. Implement
   `execute()`; the SDK serves it.
2. Write `manifests/<templateId>.v1.json`. `npm run verify` validates it against the
   vendored schema and checks that every step your code can report is declared.
3. Open a pull request here. CI runs on `GITHUB_TOKEN` alone, builds and scans the
   image, and publishes it to GHCR on merge.
4. Open a pull request adding the manifest to the platform repository's
   `manifests/` directory. There is no registration endpoint yet: `service.origin`
   is where customer documents get sent, so its write path is review.

A registered manifest at a version is **immutable.** Changing anything means a new
file at `v<n+1>` — a run pinned to v1 must still resolve the service it actually
called.

## Working here

```bash
npm ci --ignore-scripts
npm run verify        # format:check → build → typecheck → test, root and every workspace
```

Node 22 or newer. Agent sessions read `CLAUDE.md` first.
