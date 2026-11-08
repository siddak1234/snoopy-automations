# tools/n8n — n8n on the owner's Mac, to design a flow

n8n here is a **design tool, and only that**: the owner tries an idea on n8n's canvas, on this Mac,
with test files. It is **never deployed and never in an image** — no flow, no host and no CI job
runs it — because a host has no room for it (the platform's ADR-0052, context 4 and 5:
`snoopy-backend/docs/adr/0052-n8n-is-a-local-design-tool-a-hosted-n8n-waits-for-bigger-hosts.md`).
A design reaches customers only as a code flow on the SDK, written by `/create-flow` ("From a
design to a flow", below). `test/n8n-local.test.ts` holds what a file can show of this page: the
pin and its floor, the one port, the hardening keys, the data folder, nothing else in the service
(so no restart policy), and no Dockerfile, `package.json` or `package-lock.json` of a flow or the
template that names n8n.

## Start, open, stop

From the repository's root, with Docker Desktop running:

```bash
mkdir -p tools/n8n/.data
docker compose -f tools/n8n/compose.yml up -d   # runs until stopped; it never restarts by itself
```

Open <http://localhost:5678> in Chrome or Firefox: n8n refuses Safari over http, because its sign-in
cookie stays secure (n8n's default). The first visit asks for an owner account: n8n has no way to
turn its sign-in off. It lives in the data folder on this Mac, so any address and a password of its
own do.

```bash
docker compose -f tools/n8n/compose.yml down    # stops it; the data folder stays
```

`rm -rf tools/n8n/.data` after `down` starts over: every design, the sign-in and n8n's key go.

## What it runs with

All of it is in `compose.yml`, each line with its reason:

- one image, named by release and multi-arch index digest ("The pin", below);
- its port on 127.0.0.1 only, so nothing else on the network reaches the editor;
- no call to n8n's servers — no telemetry, version check or templates (n8n's
  [Isolate n8n](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/isolate-n8n));
- no community package, no environment variable read from a workflow, no public API, and no
  execution data saved, a run started by hand included
  ([n8n's environment variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/));
- five nodes in its list and no other: Webhook, Respond to Webhook, Set, If and HTTP Request (n8n
  adds HTTP Request's tool variant, `n8n-nodes-base.httpRequestTool`) — no Code node, no Execute
  Command, no file, SSH or Git node. A node added is a reviewed change to `compose.yml` and to the
  test's list together;
- its data — the designs, the sign-in, n8n's own key, the exports — in `tools/n8n/.data/`, which
  `.gitignore` keeps out of git.

A design starts with a Webhook node: press "Listen for test event", then send a test file to the
Test URL the node shows, `curl -X POST '<Test URL>' -H 'content-type: application/json' -d @<test file>`.

## The rules

1. **Test files only.** Never a customer's or a patient's data: no real patient data before
   release (the platform's BUILD-PLAN 29.4.9), and this repository is public.
2. **Never export credentials.** Never run n8n's `export:credentials`. Keys go only into n8n's
   credentials, where n8n's own key encrypts them, never into a node's field: an export carries
   every field as typed.
3. **Exports stay in the data folder,** `tools/n8n/.data/`, never in a tracked file.

## From a design to a flow

1. Export the workflow into the data folder (its id is in the editor's address, `/workflow/<id>`):

   ```bash
   mkdir -p tools/n8n/.data/exports
   docker compose -f tools/n8n/compose.yml exec n8n \
     n8n export:workflow --id=<id> --output=/home/node/.n8n/exports/<name>.json
   ```

   The file is `tools/n8n/.data/exports/<name>.json`.

2. Run `/create-flow` and give it that file as the idea, with a line on what the flow should do.
   The export is read, never served and never committed: the flow is written as code on the SDK —
   its spec, its manifest, its steps on `defineFlow`, its tests — through the skill's stages, as
   for any idea ([Build a flow](../../README.md#build-a-flow)).

## The pin

`compose.yml` names one n8n release by exact tag and multi-arch index digest. Its floor,
`N8N_FLOOR` in `test/n8n-local.test.ts`, is the lowest release the pin may name; it was set on
2026-11-06 to n8n's stable of 2026-11-04, above 2.46.1, where the 2.46 line takes the fixes of
n8n's security advisories of 2026-10-28. The test refuses a pin below it or without a digest.

Nothing moves the pin by itself (Dependabot's docker entry reads only the folders with a
Dockerfile), so bump it by hand within a week of an n8n security release, and at least monthly
(n8n's [update page](https://docs.n8n.io/deploy/host-n8n/keep-n8n-running/update-n8n): "Try to
update at least once a month."):

1. Read n8n's [releases](https://github.com/n8n-io/n8n/releases) and
   [security advisories](https://github.com/n8n-io/n8n/security/advisories), and take the newest
   stable release. A new major only after its breaking changes are read and `tools/n8n/.data` is
   copied: from 3.x the way back to 2.x is a backup.
2. Read its index digest: `docker buildx imagetools inspect docker.n8n.io/n8nio/n8n:<release>`, the
   first `Digest:` line.
3. Write the release and the digest into `compose.yml`'s `image:`, and raise `N8N_FLOOR` to the
   release in the same change.
4. Run `npx tsx --test test/n8n-local.test.ts`, then start n8n and open the editor once.
