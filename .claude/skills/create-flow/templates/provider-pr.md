# <Flow name>: the backend pull request (2 pull requests)

Filled at `/create-flow` stage 3 when the flow needs a vendor the menu
(`contract/schemas/platform-menu.json`) lacks, or a menu provider without one operation the spec's
section 3 calls. It is the spec of one `snoopy-backend` pull request, built by a backend session on
the owner's word; this repository's session never edits that repository. It merges first, then
the flow's pull request here, which re-pins `contract/` to its merge.

## The file

`providers/<id>.json` (a new vendor), or one operation added to an existing file (a data-only
edit), with only the operations section 3 names, each with its scopes:

| Operation | Method | Path (relative) | Scopes | Why the flow calls it (section 3) |
| --------- | ------ | --------------- | ------ | --------------------------------- |

- Auth: `oauth2` or `api-key` (a pasted key); plain REST. Anything else no file can describe:
  `/create-flow` stops (a platform round).
- Each operation's scopes are a subset of the provider's; every path is relative; no URL of the
  owner's and no secret (`snoopy-backend/providers/README.md`, "The rules").
- `snoopy-backend/test/provider-conformance.test.ts` passes; the diff touches no `apps/` source (Gate 5's rule).

## The menu

`npm run schemas:emit`, so `snoopy-backend/schemas/platform-menu.json` lists the provider and its operations, and
the byte check (`snoopy-backend/test/wire-schema-files.test.ts`) passes.

## The owner's console steps — all at once, before the backend merge

An OAuth2 vendor only; a pasted-key vendor has none (its keys are each workspace's own).

1. In the vendor's developer console, create the app and register the redirect URI
   `https://api.autom8x.ai/v1/connections/callback`.
2. Copy the client id and the client secret.
3. In Doppler's production config, append `<id>:<clientId>:<clientSecret>` to
   `PROVIDER_CREDENTIALS` (comma-separated entries; only the first colon ends the id).

Then the owner merges the backend pull request; its platform deploy restarts Connections, which
loads the file and the keys. Without the keys, the platform's readiness check refuses the flow at
its deploy ("not live: needs <displayName> keys on the servers (PROVIDER_CREDENTIALS)") and
nothing it serves changes; re-running the Deploy job once they are set serves it.

## The order

1. The backend pull request merges, and the platform deploys.
2. This repository's flow pull request re-pins `contract/` to that merge (all nine files, byte for
   byte; `contract/README.md` names the commit), so the menu lists the provider and
   `test/menu.test.ts` passes.
