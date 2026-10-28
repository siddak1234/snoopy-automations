---
name: create-flow
description: Use when the owner or a developer brings an idea for a new flow, in any form. One command from the idea to a live flow, reading only this repository - the idea checked against the menu (one pull request, two, or stop), at most five decisions, a spec and one words list the owner approves, one builder and one review, a pull request whose merge is the deploy, and what the pilot taught.
---

# create-flow

The owner writes an idea; this command takes it to a live flow. A flow is one automation with one
job: its own AI steps, schemas and integrations, built from the SDK and the kit, and what a person
reads of its runs sent as blocks. v4 (Round 21) reads **only this repository**: the platform sends
it **the menu**, `contract/schemas/platform-menu.json`, everything a flow may use with each
provider's operations and no secret, so it reads no `snoopy-backend` file, no client design file
(the clients draw blocks, so a flow applies no design of theirs) and no MASTER-PLAN. A flow is one
`snoopy-automations` pull request, or two when it needs a provider the menu lacks (the backend's
first); one builder, one review, and its merge is the deploy (ADR-0047). Here since 2026-10-25 (the
platform's BUILD-PLAN 29.0.5); the workspace links it.

**Who does what.** The session runs the stages, writes the brief and the records. One lane agent
(`builder`, through the `build-round` workflow) builds the flow in a scratch clone; one `reviewer`
reads it once against [templates/review.md](templates/review.md). At most three agents at once, one
heavy gate at a time (the gate lock). The owner approves the words, merges every pull request and
says go for each step that publishes or touches production.

## Inputs

- The owner's idea, in whatever form: text, a document, a diagram, screenshots. If the command came
  with nothing, ask once: "What should the flow do?" — then start.
- A customer's file is read, never committed: `snoopy-automations` is public.

## Stages

1. **Intake** (the session alone). In a fresh scratch clone of this repository (`git clone` into
   the session scratchpad; never under `~/Desktop` or iCloud Drive) read [templates/spec.md](templates/spec.md);
   `contract/README.md`, "What the platform refuses beyond the schema"; **the menu**,
   `contract/schemas/platform-menu.json` — the blocks, the page parts, the question forms, the
   setup, run-input and item-field controls, the triggers, the capabilities, each provider with its
   operations, and the limits; the blocks' shapes (`contract/schemas/automation-run-result.json`,
   its `$defs.emittedBlock`); and the newest filled spec (`automations/*/README.md`) and its
   manifest. **Check the idea against the menu** and tell the owner which it is, in one line:
   - **1 pull request** (`snoopy-automations`): every block, page part, control, trigger and limit
     the idea needs is in the menu, and so is every integration with every operation it calls;
   - **2 pull requests** (the backend's first): a vendor the menu lacks that a provider file can
     describe (OAuth2 or a pasted key, plain REST), or a menu provider that lacks one operation, a
     data-only edit to its file — stage 3, from [templates/provider-pr.md](templates/provider-pr.md);
   - **stop** (a platform round): a new block, page part, question form, target, control,
     capability, trigger, department or icon (the platform's ADR-0048 decision 12), or a vendor no
     file can describe. Nothing of the flow is built.

   Then list at most five decisions, each with a recommended default — only what the idea leaves
   open and changes the build (a field's choices, file types, who may act, what a result shows).
   Record the owner's answers verbatim, with the time, in the session's memory.

   **1b. Research** (the session; the owner says yes or corrects), in [research-stage.md](research-stage.md): the `flow-research` workflow (four `researcher` lenses, one synthesis, one skeptic), its result's checksum checked by `research-render.mjs`, the brief shown to the owner. No spec is written from a stopped run or a brief the owner has not approved.

2. **The spec and the words list** (the session; the owner approves). Copy the spec template to
   `snoopy-automations/automations/<name>/README.md` and [templates/words.md](templates/words.md)
   beside it as `words.md`; fill both from the idea, the answers and the approved brief (`research.md`: the Domain section, a source id on every domain fact). Nothing the idea does not say:
   each gap is a section 11 question with its default; a provider the platform has not goes in
   section 10, never written as if it existed. The words list is every word either client shows,
   one set for both (two clients built from one plan wrote different refusals for the same screen:
   Round 19, the website's review, finding 9). Check every word against the plain-words rules: the fewest questions, nothing a connected app knows, titles only, no jargon;
   "flow" and "department", never "automation", "team" or "project". Show the owner the words as the
   screens read them; write the date and the owner's words at the spec's top. **Nothing is
   registered before this**: a registered manifest is immutable (a change is v2). A word changed
   after the approval goes back to the owner with a dated note at the spec's top
   (Round 19, the flow's review, finding 2).
3. **The provider file, only for 2 pull requests**: the session fills
   [templates/provider-pr.md](templates/provider-pr.md) from section 3 — the file with only the
   operations the spec names, the menu re-emitted, every console step for the owner at once — and a
   `snoopy-backend` session builds it on the owner's word. It merges first; the flow's pull request
   re-pins `contract/` to its merge. One pull request: no stage 3.
4. **The build** (one lane agent): this repository's `build-round` workflow
   ([.claude/workflows/build-round.js](../../workflows/build-round.js), by `scriptPath`, the
   platform's byte for byte) with `{ runDir, task, lanes: [{ repo: 'snoopy-automations', clone }] }`
   — no `backend` clone, and without `~/.claude/autom8x/gate-lock.mjs` one heavy step at a time. The
   task names the spec, the words list, [templates/lane-brief.md](templates/lane-brief.md) and
   [templates/review.md](templates/review.md); the reviewer reads only the brief and the diff. The
   lane writes the manifest from sections 1–3, 5–7, runs `npm run scaffold -- <name>` (the
   repository README, "Build a flow"), then the steps on `defineFlow`, the prompts (section 4), the
   blocks through `boundedBlocks` (section 7) and the tests (section 9). It never edits another
   repository: a shape the menu lacks is a finding, and the round stops (stage 1).
5. **One review** (one `reviewer`, run by the workflow as the lane ends) against
   [templates/review.md](templates/review.md), its fixed checklist; CI's review rows answer what a
   machine can. Six fixes or fewer are made by hand; more go back to the lane once.
6. **The merge** (the session prepares each step; the owner merges): in the order of
   [templates/order.md](templates/order.md) — the provider file's pull request first when there is
   one, then the automations pull request — written out for the owner with each pull request's link once its
   required check is green on the head, and its hold for the pilot. The merge is the deploy: the
   session reads the Deploy job's summary and the platform's Flow CD run; no pin or release follows.
7. **The screens** (the session; the owner's phone): once deployed, the website and the app read as
   the spec and the words list do — the catalog card, the questions, the steps, a run's blocks, the
   email. The app on one headless simulator only with the owner's OK, or the owner's own TestFlight
   test. The owner's feedback from that test goes through the `feedback-intake` skill; each wording
   rule it settles is written into [templates/words.md](templates/words.md) or the spec template in
   the fix's own pull request, so every later flow reads it at stage 1 and its reviews check it.
8. **What the pilot taught** (the session; kept for every flow): every place this skill or its
   templates were unclear or wrong, fixed in them in the round's own `snoopy-automations` pull request,
   each fix citing its evidence in one clause, and listed in the round's records; each pilot failure added to [evals/research.md](evals/research.md).

## Stop when

- The owner has not approved the research brief, or research.json failed its checksum twice: no spec is written.
- The owner has not approved the words: nothing is registered.
- The idea needs a new block, page part, question form or target, or anything else the menu does not offer but a provider file: a platform change, never built inside a flow.
- A new vendor or operation needs its provider file, and the owner has not done its console steps or said to build it.
- A step needs an edit outside the flow's lane: that is a finding, not an edit.
- A merge, a publish or a production step without the owner's go: give the owner the link or the line, and wait.

## Output

- The approved spec, its words list and its research brief (`research.md`) at `snoopy-automations/automations/<name>/`; the flow's pull
  request, and the provider file's when there is one (its spec from provider-pr.md); the order written out (stage 6); the round's
  records; this skill corrected (stage 8).

## Docs

`docs/docs-map.json` rule `claude`: a change under `.claude/` needs CLAUDE.md in the same range.
The workspace links this folder (`snoopy-backend/scripts/claude-install.mjs --workspace`), so a
merged change reaches it with a `git pull` of the workspace copy, no reinstall.
