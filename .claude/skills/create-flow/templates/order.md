# <Flow name>: the merge order

A flow is up to three pull requests: the backend's provider file first, step 1, when the menu lacks
a provider or an operation it calls (`provider-pr.md`); the SDK change next, step 2, when the flow
changes `packages/automation-sdk/`; then the automations pull request, step 3, always. A merge to
`main` is the deploy (the platform's ADR-0047): no pin, registration or release pull request
follows one, and no client pull request comes with it (`/create-flow` v4, Round 21). The session
writes this list out for the owner at stage 1, every pull request up front, and fills it in through
stage 6 — each pull request's link once its required check is green on the head, each run's
summary as read. The owner merges every pull request, and says go, in manual permission mode, for
any step that touches production outside a merge. An integration the idea names (a live intake, a
write-back) is planned here at stage 1 — its research, its provider file or its platform round,
and its pull request — never only a "next version" row (the ICD-10 pilot, F4: "Integrations for
step 1. Your review after completion of approving it should automatically go into the ehr
system.").

## The check (stage 1)

The session tells the owner, in one line, which of these the idea is:

- **1 pull request** (`snoopy-automations`): every block, page part, control, trigger and limit the
  idea needs is in the menu, and so is every integration with every operation it calls;
- **2 pull requests** (the backend's first): a vendor the menu lacks that a provider file can
  describe (OAuth2 or a pasted key, plain REST), or a menu provider that lacks one operation, a
  data-only edit to its file — stage 3, from `provider-pr.md`;
- **one more, the SDK's**, added to either: the flow needs a change to `packages/automation-sdk/`
  (step 2) — up to three pull requests;
- **stop** (a platform round): a new block, page part, question form, target, control, capability,
  trigger, department or icon (the platform's ADR-0048 decision 12), or a vendor no file can
  describe. Nothing of the flow is built.

**The hold (the pilot, 29.4.1).** An installed app build never asks for blocks (the platform's
ADR-0048, Consequences): it shows a run that sent only blocks with its header, summary, files and
Run details, but not its body. So until the TestFlight build that draws blocks (its 29.1.3) is
live, the session prepares step 3 and the owner does not merge it; the session says so with the
link.

1. **The provider file** (only when the menu lacks a provider or an operation): the `snoopy-backend` pull request
   [provider-pr.md](provider-pr.md) specifies, its one `providers/<id>.json` and the menu re-emitted,
   the owner's console steps done first. The session
   pushes and opens it; while Actions is out of minutes, `node scripts/local-ci.mjs --pr <n>` posts
   the required check, `local/all-green`. Merge; read its CD run
   (`snoopy-backend/.github/workflows/cd.yml`): its summary, then the public entrance.
2. **The SDK change** (only when the flow needs one): its own `snoopy-automations` pull request for
   `packages/automation-sdk/`, built first by its own lane — its own `build-round` run and scratch
   clone at stage 4, the brief from `lane-brief.md` naming only the SDK change, one review at stage
   5 — then its gate and its merge, before step 3; the flow's lane clones `main` after this merge
   (the ICD-10 pilot: the SDK half had to be split out (#65 before #66)).
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
