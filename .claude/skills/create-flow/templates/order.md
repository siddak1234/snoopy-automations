# <Flow name>: the merge order

A flow is one `snoopy-automations` pull request, and a merge to `main` is the deploy (the
platform's ADR-0047): no pin, registration or release pull request follows one, and no backend or
client pull request comes with it (`/create-flow` v3, the platform's BUILD-PLAN 29.3). The session
writes this list out for the owner at stage 6 and fills it in as it goes — each pull request's link
once its required check is green on the head, each run's summary as read. The owner merges every
pull request, and says go, in manual permission mode, for any step that touches production outside
a merge. No new vendor: no step 1.

**The hold (the pilot, 29.4.1).** An installed app build never asks for blocks (the platform's
ADR-0048, Consequences): it shows a run that sent only blocks with its header, summary, files and
Run details, but not its body. So until the TestFlight build that draws blocks (its 29.1.3) is
live, the session prepares step 2 and the owner does not merge it; the session says so with the
link.

1. **The provider file** (a new vendor only): the `snoopy-backend` pull request with its one
   `providers/<id>.json`, the owner's credentials set in the vendor's console first. The session
   pushes and opens it; while Actions is out of minutes, `node scripts/local-ci.mjs --pr <n>` posts
   the required check, `local/all-green`. Merge; read its CD run
   (`snoopy-backend/.github/workflows/cd.yml`): its summary, then the public entrance.
2. **The automations pull request.** Its `contract/` is the platform's `main`'s `schemas/`, byte for
   byte (`cmp` each file, the commit cited in `snoopy-automations/contract/README.md`); re-vendored
   first if the platform's `schemas/` moved since. Then its gate. Merge; read the Deploy job's
   summary, each automation's outcome as README.md's 'Adding an automation' step 4 lists them, and
   the platform's Flow CD run it dispatched.
3. **The screens**: the website and the app read the flow from the platform — no client pull
   request, no TestFlight build for a flow; then the owner's test on the phone, and stage 7's
   screens.
