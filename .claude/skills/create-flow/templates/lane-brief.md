# Brief — <repo> lane: <what it builds> (Round <n>)

The fixed parts of every lane brief; the session fills the angle brackets and writes the Build
section. The `build-round` workflow hands the brief to its lane by path, at `<runDir>/brief-<repo>.md`.

Clone: `<scratch>/clones/<repo>`, branch `round-<n>/<topic>` from `origin/main` at `<sha>` (a client
whose `main` is red for another reason branches from that fix's branch: order.md, step 0).
Node 22 in every shell: `export PATH=$HOME/.nvm/versions/node/v22.23.2/bin:$PATH`.

Read first: CLAUDE.md (and AGENTS.md where present), docs/MAP.md, this repository's skill for the
change (`new-automation-version`, `new-page`, `new-screen`); then the spec,
`snoopy-automations/automations/<name>/README.md`, the words list beside it, and the sections of
`<runDir>/plan.md` this lane builds. Grep a file over 100 KB; never read it whole.

## The contract — every lane but the backend's

The round's contract is the backend commit in `<runDir>/contract.done`, checked out read-only at
`<scratch>/clones/backend-contract`. Never edit it.

- A client: `export SNOOPY_BACKEND_ROOT=<scratch>/clones/backend-contract` in every shell (the
  types' generation, verify, the contract tests, the pre-push hook) — never `../snoopy-backend`,
  another lane's moving work (Round 19, the website's `next` bump). Generate the types with
  `npm run generate:platform-contracts` and commit them. Before the final gate, regenerate from the
  backend's last head, which the session names (Round 19, the app's review, finding 7).
- The automations flow: re-vendor `contract/schemas/*.json` byte for byte, and
  `snoopy-automations/contract/README.md`'s "What changed at this pin" and its vendored "What the
  platform refuses beyond the schema".

A shape the lane needs that is not there is a finding in the summary, never a guess and never an
edit.

## Build

<What to build, from the spec, the words list and the plan; the files it may open; anything the
plan leaves open is chosen by the nearest precedent in this repository and named in the summary.>

## Tests that bite

Each behaviour has a test that fails without it: break the line, see it red, restore it (the file's
sha equal), see it green; each bite listed in the summary. Fixtures are made up. Above all:

- an order the platform gives (a ranking) is tested with fixtures a client's own sort would change
  (Round 19, the website's review, finding 8, Round 19, the app's review, finding 2);
- each owner-or-admin action has a member's refusal test (Round 19, the website's review, finding 7);
- a value picked from a list the client re-reads is tested by what is sent, never by its label
  (Round 19, the website's review, finding 1, Round 19, the app's review, finding 3);
- the backend: a query by id also names the workspace, and a test names another workspace's real
  row, not a random id (Round 19, the platform's review, finding 6, 7);
- the automations flow: each failure of spec section 8 and each case of section 9; made-up links on
  reserved hosts (`example.com`), never a real site's plausible handle
  (Round 19, the flow's review, finding 8);
- a file's links are read from the file itself (a PDF's link annotations, a Word file's
  hyperlinks), not only what is printed (Round 19, build 28, F8);
- a held run's decision stays on the run's own page (Round 19, build 28, the parity review,
  finding 1);
- a client draws a file in place only by its content type, in a folder of its own, with scripts
  off (Round 19, build 28, the app's review, finding 5).

## Docs and records — in the same commit

`docs/docs-map.json` says which doc each change needs; `npm run check:docs` passes.

- The backend: SYSTEM-MANIFEST's routes, tables and migration; `npm run records:facts`; §14's total
  by `node scripts/run-tests.mjs --record` at the lane's final head (a test added after the record
  left verify red: Round 19, the platform's review, finding 1). A new operation that starts a run names the
  run creation's 429 reasons (Round 19, the platform's review, finding 2).
- The automations flow: the repository README links the spec's sections and never restates them
  (Round 19, the flow's review, finding 9).
- The app: no Prettier — never `prettier --write`; `npm run lint` is its format check.

## Gate and finish

Heavy steps (an install, verify, a whole test run, Docker, an audit) only between
`node ~/.claude/autom8x/gate-lock.mjs acquire <label>` and `node ~/.claude/autom8x/gate-lock.mjs release <label>`;
always release. On the committed tree:

| Lane        | The gate                                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| backend     | `npm ci`, `npm run verify`                                                             |
| automations | `npm ci --ignore-scripts`, `npm run verify`, `npm audit --omit=dev --audit-level=high` |
| website     | `npm ci`, `npm run verify`, `npm audit --omit=dev --audit-level=high`                  |
| app         | `npm ci`, `CI=1 npm run verify`, `npm run audit:dependencies`                          |

Commit messages end with the attribution line the `builder` agent names. Do not push: the session or
the workflow's land stage does. Never boot a simulator in a lane. Stop every process you started.
Summary (2 KB or less) at `<runDir>/lane-<repo>.summary.md`: commits, files, tests with their bite
proofs, gate counts, findings against the contract or the spec, leftovers.
