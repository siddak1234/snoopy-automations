# <Flow name>: the merge order

A flow is one `snoopy-automations` pull request, or two when the menu lacks a provider or an
operation it calls (the backend's provider file first, step 1: `provider-pr.md`), and a merge to
`main` is the deploy (the platform's ADR-0047): no pin, registration or release pull request
follows one, and no client pull request comes with it (`/create-flow` v4, Round 21). The session
writes this list out for the owner at stage 1, every pull request up front, and fills it in as it
goes — each pull request's link
once its required check is green on the head, each run's summary as read. The owner merges every
pull request, and says go, in manual permission mode, for any step that touches production outside
a merge. No new vendor: no step 1. A flow that changes the SDK has that change as its own pull
request, merged before the flow's, step 2 (the ICD-10 pilot: the SDK half had to be split out (#65 before
#66)). An integration the idea names (a live intake, a write-back) is planned here at stage 1 — its
research, its provider file or its platform round, and its pull request — never only a "next
version" row (the ICD-10 pilot, F4: "Integrations for step 1. Your review after completion of
approving it should automatically go into the ehr system.").

**The hold (the pilot, 29.4.1).** An installed app build never asks for blocks (the platform's
ADR-0048, Consequences): it shows a run that sent only blocks with its header, summary, files and
Run details, but not its body. So until the TestFlight build that draws blocks (its 29.1.3) is
live, the session prepares step 3 and the owner does not merge it; the session says so with the
link.

1. **The provider file** (two pull requests only): the `snoopy-backend` pull request
   [provider-pr.md](provider-pr.md) specifies, its one `providers/<id>.json` and the menu re-emitted,
   the owner's console steps done first. The session
   pushes and opens it; while Actions is out of minutes, `node scripts/local-ci.mjs --pr <n>` posts
   the required check, `local/all-green`. Merge; read its CD run
   (`snoopy-backend/.github/workflows/cd.yml`): its summary, then the public entrance.
2. **The SDK change** (only when the flow needs one): its own `snoopy-automations` pull request for
   `packages/automation-sdk/`; its gate, then merge, before step 3.
3. **The automations pull request.** Its `contract/` is the platform's `main`'s `schemas/`, byte for
   byte (`cmp` each file, the commit cited in `snoopy-automations/contract/README.md`); re-vendored
   first if the platform's `schemas/` moved since — after step 1, to its merge, so the menu lists the
   provider. Then its gate. Merge; read the Deploy job's
   summary, each automation's outcome as README.md's 'Build a flow' step 5 lists them, and
   the platform's Flow CD run it dispatched. The live flows' rows are there too (README.md,
   'Build a flow', says why).
4. **The screens**: the website and the app read the flow from the platform — no client pull
   request, no TestFlight build for a flow; then the owner's test on the phone, and stage 7's
   screens.
