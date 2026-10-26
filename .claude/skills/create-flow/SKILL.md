---
name: create-flow
description: Use when the owner brings an idea for a new flow, in any form. One command from the idea to a live flow - at most five decisions, a spec and one words list the owner approves, lanes in parallel (three agents at most), one review each, the merge order (the merge is the deploy), and what the pilot taught.
---

# create-flow

The owner writes an idea; this command takes it to a live flow. A flow is one automation with one
job: its own AI steps, JSON schemas and integrations, built from the SDK and the kit.
`snoopy-automations` holds the flows; `snoopy-backend` registers them and holds the secrets, the
shared integrations and what every flow may declare; the website and the app draw what the platform
sends, with no code for one flow (MASTER-PLAN §3.4). ENGINEERING-STANDARD (f) and (i).
It lives in this repository since 2026-10-25, the owner's word (the platform's BUILD-PLAN 29.0.5);
the workspace links it from here. Its stages are v2's until 29.3 makes it one pull request a flow.

**Who does what.** The session runs the stages, writes the briefs and the records. Lane agents
(`builder`, through the `build-round` workflow) build one repository each: at most three agents at
once, one heavy gate at a time (the gate lock). A `reviewer` reads each lane once. The owner
approves the words, merges every pull request and says go for each step that publishes or touches
production.

## Inputs

- The owner's idea, in whatever form: text, a document, a diagram, screenshots. If the command came
  with nothing, ask once: "What should the flow do?" — then start.
- A customer's file is read, never committed: `snoopy-automations` is public.

## Stages

1. **Intake** (the session alone). In fresh scratch clones (`git clone` into the session
   scratchpad; never under `~/Desktop` or iCloud Drive) read [templates/spec.md](templates/spec.md);
   `snoopy-automations/contract/README.md`, "What the platform refuses beyond the schema"; the
   integrations and their operations (`snoopy-backend/providers/*.json`); the clients' design
   standards and plain-words rules (`snoopy-mobile/DESIGN-CONTRACT.md`, `snoopy-mobile/app/CLAUDE.md`;
   `snoopy/AGENTS.md`, `snoopy/app/CLAUDE.md`); the newest filled spec
   (`snoopy-automations/automations/*/README.md`) and its manifest; MASTER-PLAN §0.1. Then list at
   most five decisions, each with a recommended default — only what the idea leaves open and changes
   the build (a field's choices, file types, who may act, what a result shows). Record the owner's
   answers verbatim, with the time, in the session's memory.
2. **The spec and the words list** (the session; the owner approves). Copy the spec template to
   `snoopy-automations/automations/<name>/README.md` and [templates/words.md](templates/words.md)
   beside it as `words.md`; fill both from the idea and the answers. Nothing the idea does not say:
   each gap is a section 11 question with its default; a value outside the platform's lists goes in
   section 10 with its repository and change, never written as if it existed. The words list is
   every word either client shows, one set for both (two clients built from one plan wrote different
   refusals for the same screen: Round 19, the website's review, finding 9). Check every word against the
   plain-words rules: the fewest questions, nothing a connected app knows, titles only, no jargon;
   "flow" and "department", never "automation", "team" or "project". Show the owner the words as the
   screens read them; write the date and the owner's words at the spec's top. **Nothing is
   registered before this**: a registered manifest is immutable (a change is v2). A word changed
   after the approval goes back to the owner with a dated note at the spec's top
   (Round 19, the flow's review, finding 2).
3. **The platform's half first** (the session, then one backend lane). Section 10 empty: only the
   flow lane — go to stage 4. Not empty: list each line with its repository; built only on the
   owner's word, as one round, in this order:
   - the round's records (the `records-update` skill: MASTER-PLAN §0.1 and §5, the PLAYBOOK card, a
     BUILD-PLAN phase with its gate), and an ADR for a new concept;
   - the **contract commit first**, one `builder` on the backend branch: the types, the wire
     schemas and the validator with each refusal's test, `snoopy-backend/schemas/` emitted,
     `snoopy-backend/docs/openapi/automations.yaml` with the `details` shape of every refusal a client draws
     (Round 19, a lane's finding against the contract), and the new refusals in `snoopy-backend/manifests/README.md`'s "What the
     validator refuses, beyond the schema", which `snoopy-automations` vendors
     (Round 19, a lane's finding against the contract). Its sha goes to `<runDir>/contract.done`;
   - a read-only snapshot of that commit, which every other lane reads and none edits:
     ```bash
     git clone -q "<backend clone>" "<scratch>/clones/backend-contract"
     git -C "<scratch>/clones/backend-contract" checkout -q --detach "$(cat <runDir>/contract.done)"
     ```
     After it the contract changes only to fix a defect, each fix listed in the backend lane's
     summary; the client lanes regenerate their types from the backend's last head before their
     final gate (Round 19, the app's review, finding 7).
4. **The lanes, in parallel** (lane agents). The session runs the `build-round` workflow with
   `{ runDir, backend, task, lanes: [{ repo, clone, mechanical }] }` — backend platform, the
   automations flow, website, app; only the flow's when section 10 is empty. The task names the spec,
   the words list, the snapshot and [templates/lane-brief.md](templates/lane-brief.md), whose fixed
   parts every brief the design stage writes carries. Every client lane exports
   `SNOOPY_BACKEND_ROOT` to the snapshot in every shell, never `../snoopy-backend`: that is another
   lane's moving work, and a client's pre-push failed three contract tests on it
   (Round 19, the website's `next` bump). The flow lane uses `snoopy-automations`' `/new-automation-version`:
   the manifest from sections 1–3, 5–7, the prompts from section 4, the code from the steps, the
   tests from section 9.
5. **One review per lane** (a `reviewer` each, run by the workflow as each lane ends): the flow
   against its spec, with [templates/review.md](templates/review.md) as its brief; each client
   against the words list and the other client's branch, for parity — the website's review found
   the app's gaps (Round 19, the website review's list for the app). Six fixes or fewer are made by hand; more go
   back to their lane once.
6. **The merges** (the session prepares each step; the owner merges): in the order of
   [templates/order.md](templates/order.md), written out for the owner with each pull request's
   link once its required check is green on the head. Each merge is the deploy: the session reads
   its run (the backend's CD, this repository's Deploy job), and no pin or release step follows.
7. **The screens** (the session; the owner's phone): once deployed, the website and the app read as
   the spec and the words list do — the catalog card, the questions, the steps, a run's results, the
   email. The app on one headless simulator only with the owner's OK, or the owner's own TestFlight
   test. The owner's feedback from that test goes through the `feedback-intake` skill; each design or
   wording rule it settles is written into its standard (stage 1's four files) in the fix's own pull
   request, so every later flow reads it at stage 1 and its reviews check it.
8. **What the pilot taught** (the session; kept for every flow): every place this skill or its
   templates were unclear or wrong, fixed in them in the round's own `snoopy-automations` pull request,
   each fix citing its evidence in one clause, and listed in the round's records.

## Stop when

- The owner has not approved the words: nothing is registered.
- Section 10 is not empty and the owner has not said to build it.
- A step needs an edit outside the round's lanes: that is a finding, not an edit.
- A merge, a publish or a production step without the owner's go: give the owner the link or the
  line, and wait.

## Output

- The approved spec and its words list at `snoopy-automations/automations/<name>/`; each lane's pull
  request; the order written out (stage 6); the round's records; this skill corrected (stage 8).

## Docs

`docs/docs-map.json` rule `claude`: a change under `.claude/` needs CLAUDE.md in the same range.
The workspace links this folder (`snoopy-backend/scripts/claude-install.mjs --workspace`), so a
merged change reaches it with a `git pull` of the workspace copy, no reinstall.
