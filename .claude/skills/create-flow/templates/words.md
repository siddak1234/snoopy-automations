# <Flow name>: words list

**Approved with the spec:** <YYYY-MM-DD, the owner's words> · **Spec:** `README.md` beside this file

Every word a person reads on either client for this flow: one set, both clients (the owner's parity
rule). Two clients built from one plan without it wrote different refusals, confirmations and
"try again" lines for the same screen (Round 19, the website's review, finding 9). Each word has one home:

- **The manifest**, for the flow's own words: its name, questions, steps, a run's results, failures
  and items. They live in the spec (section 1 below points there, never copies them: a second copy
  drifted at once, Round 19, the flow's review, finding 9). The clients draw them as the platform
  sends them and never write them, not even as an example in a comment
  (Round 19, the app's review, finding 4).
- **This list**, for the clients' own words on a screen or a refusal that a platform round adds
  (spec section 10: stop): written once here, copied word for word into both clients, with
  `{placeholders}` for what the manifest gives ("Upload {one}", "No {many} yet.", "{n} {runs} · Top
  {score}").

Plain words: the fewest, titles only, no jargon; "flow" and "department", never "automation", "team"
or "project". A word changed after the approval goes back to the owner with a dated note at the
spec's top.

## 1. The flow's words — in the spec

| Screen                                     | The spec's section                         |
| ------------------------------------------ | ------------------------------------------ |
| The catalog card                           | 1 (name, one line, department, icon)       |
| Starting a run, and an item's upload       | 2 (run inputs; items: words, fields, file) |
| Setting it up                              | 5 (the questions)                          |
| The numbered steps, and the steps of a run | 6                                          |
| A run's results                            | 7 (title, score, summary, blocks, held)    |
| When it fails                              | 8                                          |

## 2. The clients' own words — none for a flow

Since `/create-flow` v3 a flow adds no screen and no client words: the clients draw it from its
manifest and its blocks. A screen or refusal of their own is a platform change (spec section 10:
stop), and its words are written here, in that round, in the shape below.

| Screen | Where on it | The words, with {placeholders} | Shown when | Who sees it |
| ------ | ----------- | ------------------------------ | ---------- | ----------- |

Each new screen has a row for each of these, or says why it needs none:

- empty ("No {many} yet."), still working ("Reading…"), and a read that failed ("Unavailable" —
  never the empty words, which would say there is nothing: Round 19, the website's review, finding 2);
- each refusal the platform can answer with, by its `details.reason`, and a refused field's words
  under that field;
- the confirmation before an action that cannot be undone;
- what a member sees where only owners and admins act ("Only an owner or admin can do this.");
- a finished run with no title, named by its status, the same words on both
  (Round 19, the website's review, finding 4).

## 3. The layout

A flow's layout is its manifest's `display.pages` and the order of its blocks (spec section 7);
what follows is for a platform round's new screen. One sketch per new screen, the same for both
clients: what is drawn, in which order, which parts
only owners and admins see, what is open and what collapsed, and the order the platform gives that
the clients keep (a ranking is drawn as the platform answers it, never re-sorted). Start each sketch
from the clients' design standards (`snoopy-mobile/DESIGN-CONTRACT.md`, `snoopy/docs/ARCHITECTURE.md`), which
hold the page orders the owner's test of Round 19's build 28 settled: a list field is the glass
dropdown; the flows list is grouped by department A–Z; a flow with items shows its items, filtered by
its group; an item's page is its tiles, its file's row, the add, then compact ranked rows; every
uploaded file opens to view, download and share; a run's page ends with the "Run details" row, then
View flow.
