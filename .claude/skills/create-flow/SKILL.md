---
name: create-flow
description: Use when the owner brings an idea for a new flow, in any form. One command from the idea to a live flow - the idea checked against the blocks and the providers, at most five decisions, a spec and one words list the owner approves, one builder and one review, one snoopy-automations pull request whose merge is the deploy, and what the pilot taught.
---

# create-flow

The owner writes an idea; this command takes it to a live flow. A flow is one automation with one
job: its own AI steps, JSON schemas and integrations, built from the SDK and the kit, and what a
person reads of its runs sent as blocks. `snoopy-automations` holds the flows; `snoopy-backend`
holds the secrets, the providers, the blocks and what every flow may declare; the website and the
app draw what the platform sends, with no code for one flow (MASTER-PLAN §3.4; the platform's
ADR-0048). ENGINEERING-STANDARD (f) and (i). It lives in this repository since 2026-10-25, the
owner's word (the platform's BUILD-PLAN 29.0.5); the workspace links it from here. This is v3 (its
BUILD-PLAN 29.3, Round 21): a flow is one `snoopy-automations` pull request, built by one builder
and read by one review, and its merge is the deploy (ADR-0047) — no backend pull request and no
client lane.

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

1. **Intake** (the session alone). In fresh scratch clones (`git clone` into the session
   scratchpad; never under `~/Desktop` or iCloud Drive) read [templates/spec.md](templates/spec.md);
   `snoopy-automations/contract/README.md`, "What the platform refuses beyond the schema"; the
   blocks (`snoopy-automations/contract/schemas/automation-run-result.json`, its
   `$defs.emittedBlock`) and the page parts (`automation-manifest.json`, `display.pages`); the
   integrations and their operations (`snoopy-backend/providers/*.json`); the clients' design
   standards and plain-words rules (`snoopy-mobile/DESIGN-CONTRACT.md`, `snoopy-mobile/app/CLAUDE.md`;
   `snoopy/AGENTS.md`, `snoopy/app/CLAUDE.md`); the newest filled spec
   (`snoopy-automations/automations/*/README.md`) and its manifest; MASTER-PLAN §0.1. **Check the
   idea against the blocks and the providers** (29.3.1) and tell the owner which it is, in one line:
   - **everything there** (the twelve blocks, the closed set of page parts, the manifest's controls, a
     provider for each integration with its operations): one `snoopy-automations` pull request;
   - **a new vendor**, which no provider file declares: that pull request and one provider file in
     `snoopy-backend`, with the owner's credentials (every console step listed at once);
   - **a new block, page part, question form or target** (the platform's ADR-0048 decision 12), or a
     control, capability, trigger, department or icon the schema lacks (a platform round under v3: a
     flow has no platform lane, 29.3.2): **stop** — a platform change. Nothing of the flow is built.

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
3. **The provider file, only for a new vendor** (the session, then one `snoopy-backend` lane, on
   the owner's word). Section 10's one line: `snoopy-backend/providers/<id>.json` with the operations
   the spec names, built and reviewed once, with the owner's credentials set by the owner in the
   vendor's console. No schema, contract or client change rides with it. No new vendor: no stage 3.
4. **The build** (one lane agent). The session runs the `build-round` workflow with
   `{ runDir, backend, task, lanes: [{ repo: 'snoopy-automations', clone }] }`, `backend` a
   `snoopy-backend` scratch clone (required: the workflow runs hygiene there). The task names the
   spec, the words list, [templates/lane-brief.md](templates/lane-brief.md) and [templates/review.md](templates/review.md);
   the design stage writes the one brief with lane-brief.md's fixed parts, and the reviewer reads
   only it and the diff. The lane uses
   `/new-automation-version`: the manifest from sections 1–3, 5–7 (`display.pages` when section 7
   orders the pages), the prompts from section 4, the code from the steps, the result in blocks
   through the SDK's `boundedBlocks` (section 7), the tests from section 9. It never edits `snoopy-backend`, `snoopy` or
   `snoopy-mobile`: a shape it needs that is not there is a finding, and the round stops (stage 1).
5. **One review** (one `reviewer`, run by the workflow as the lane ends) against
   [templates/review.md](templates/review.md), its fixed checklist. Six fixes or fewer are made by
   hand; more go back to the lane once.
6. **The merge** (the session prepares each step; the owner merges): in the order of
   [templates/order.md](templates/order.md) — the provider file first when there is one, then the
   automations pull request — written out for the owner with each pull request's link once its
   required check is green on the head, and its hold for the pilot. The merge is the deploy: the
   session reads the Deploy job's summary and the platform's Flow CD run; no pin or release follows.
7. **The screens** (the session; the owner's phone): once deployed, the website and the app read as
   the spec and the words list do — the catalog card, the questions, the steps, a run's blocks, the
   email. The app on one headless simulator only with the owner's OK, or the owner's own TestFlight
   test. The owner's feedback from that test goes through the `feedback-intake` skill; each design or
   wording rule it settles is written into its standard (stage 1's four files) in the fix's own pull
   request, so every later flow reads it at stage 1 and its reviews check it.
8. **What the pilot taught** (the session; kept for every flow): every place this skill or its
   templates were unclear or wrong, fixed in them in the round's own `snoopy-automations` pull request,
   each fix citing its evidence in one clause, and listed in the round's records; each pilot failure added to [evals/research.md](evals/research.md).

## Stop when

- The owner has not approved the research brief, or research.json failed its checksum twice: no spec is written.
- The owner has not approved the words: nothing is registered.
- The idea needs a new block, page part, question form or target, or anything else the platform does not offer: a platform change, never built inside a flow.
- A new vendor needs its provider file, and the owner has not given its credentials or said to build it.
- A step needs an edit outside the flow's lane: that is a finding, not an edit.
- A merge, a publish or a production step without the owner's go: give the owner the link or the line, and wait.

## Output

- The approved spec, its words list and its research brief (`research.md`) at `snoopy-automations/automations/<name>/`; the flow's pull
  request, and the provider file's when there is one; the order written out (stage 6); the round's
  records; this skill corrected (stage 8).

## Docs

`docs/docs-map.json` rule `claude`: a change under `.claude/` needs CLAUDE.md in the same range.
The workspace links this folder (`snoopy-backend/scripts/claude-install.mjs --workspace`), so a
merged change reaches it with a `git pull` of the workspace copy, no reinstall.
