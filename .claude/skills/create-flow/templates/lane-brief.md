# Brief — snoopy-automations lane: <the flow> (Round <n>)

The fixed parts of the flow's brief (`/create-flow` v4: one builder, one review, one pull request);
the `build-round` workflow's design stage fills the angle brackets and writes the Build section, and
the workflow hands the brief to its lane and its reviewer by path, at
`<runDir>/brief-snoopy-automations.md`. A new vendor's provider
file is the session's own `snoopy-backend` lane before it (order.md, step 1): one
`providers/<id>.json`, its test and the records, no schema and no client change.

Clone: `<scratch>/clones/snoopy-automations`, branch `round-<n>/<topic>` from `origin/main` at
`<sha>`. Node 22 in every shell: `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`.

Read first: CLAUDE.md, docs/MAP.md, the `new-automation-version` skill; then the spec,
`automations/<name>/README.md`, the words list and the research brief beside it
(`automations/<name>/research.md`), and the sections of `<runDir>/plan.md` this lane builds. Grep a file over 100 KB; never read it whole.

## The contract

`contract/schemas/` is the platform's `main`'s `schemas/`, byte for byte (the commit is named in
`contract/README.md`): the menu (`platform-menu.json`: the blocks, page parts, controls, triggers,
capabilities, each integration's operations and the limits), the blocks' shapes
(`automation-run-result.json`, `$defs.emittedBlock`), the page parts (`automation-manifest.json`,
`display.pages`) and, in `contract/README.md`, the rules beyond the schema. Never edit it but to re-vendor. A shape the flow needs that is not there — a block, a
page part, a question form or a target (the platform's ADR-0048 decision 12), or a control (a
platform round under v3: a flow has no platform lane, 29.3.2) — is a finding in the summary and
the end of the lane: a platform change, never a guess and never an edit.
The lane edits no other repository.

## Build

Write `manifests/<name>.v1.json` from the spec's sections 1–3 and 5–7, then `npm run scaffold --
<name>`: the frame (README.md, "Build a flow", step 2). The lane writes the steps on `defineFlow`
(each risky call through `settle`, each failure through `failed` in section 8's words), the prompts
and the tests; `automations/<id>/test/drill.test.ts` gets what a good run reads (README.md, "A new flow's standards").

<What to build, from the spec, the words list and the plan; the files it may open; anything the
plan leaves open is chosen by the nearest precedent in this repository and named in the summary —
a precedent of code, never a domain fact: a domain fact not in the spec or research.md is a
finding, never chosen.>

The lane does no web search or fetch: what the flow knows of its domain is the spec and
research.md, and nothing else (Anthropic, "Mitigate jailbreaks and prompt injections", in the skill's `research-stage.md` sources: "Apply the principle of least privilege so that a successful injection can do minimal damage").

What a person reads of a run is `blocks`, built from spec section 7 through the SDK's
`boundedBlocks` (README.md, "What an automation looks like"), never with `sections` or `details`;
`display.pages` only when section 7 orders the pages.

## Tests that bite

Each behaviour has a test that fails without it: break the line, see it red, restore it (the file's
sha equal), see it green; each bite listed in the summary. Fixtures are made up. Above all:

- each failure of spec section 8 and each case of section 9; made-up links on reserved hosts
  (`example.com`), never a real site's plausible handle (Round 19, the flow's review, finding 8);
- the blocks: section 7's types, order and words, asserted block by block, in an order a sort would
  change; a model's words the platform would refuse (a long line, a tag) sent bounded, never
  refused (the platform's ADR-0048 decision 3);
- a file's links are read from the file itself (a PDF's link annotations, a Word file's
  hyperlinks), not only what is printed (Round 19, build 28, F8);
- what the spec's privacy rows leave out of a model call, one test each (Round 19, the flow's
  review, finding 1).

## The review

The review: `.claude/skills/create-flow/templates/review.md`, its checklist. The reviewer reads this
brief and the diff, nothing else, so this line is how the checklist reaches it.

## Docs and records — in the same commit

`docs/docs-map.json` says which doc each change needs; `npm run check:docs` passes. The repository
README links the spec's sections and never restates them (Round 19, the flow's review, finding 9).

## Gate and finish

Heavy steps (an install, verify, a whole test run, Docker, an audit) only between
`node ~/.claude/autom8x/gate-lock.mjs acquire <label>` and `node ~/.claude/autom8x/gate-lock.mjs release <label>`;
always release. On the committed tree: `npm ci --ignore-scripts`, `npm run verify`,
`npm audit --omit=dev --audit-level=high` (the provider file's lane: `npm ci`, `npm run verify`).

Commit messages end with the attribution line the `builder` agent names. Do not push: the session or
the workflow's land stage does. Stop every process you started. Summary (2 KB or less) at
`<runDir>/lane-snoopy-automations.summary.md`: commits, files, tests with their bite proofs, gate
counts, findings against the contract or the spec, leftovers.
