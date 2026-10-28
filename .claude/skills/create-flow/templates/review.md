# Review brief — the flow against its approved spec and its words list

The fixed checklist (`/create-flow` v3, the platform's BUILD-PLAN 29.3.2): one reviewer pass on the
flow's one `snoopy-automations` pull request. Never edit. Write PASS or FAIL on line 1, then 10
findings or fewer, each `file:line — problem — fix`. A check you could not make is a finding
written `UNKNOWN — <why>`, never a PASS. A flow has no client lane: the website and the
app draw it from its manifest and its blocks.

## The flow, against its spec

`git diff <base>..HEAD` in the flow's `snoopy-automations` branch, against
`automations/<name>/README.md` (approved: its top line carries the owner's words).

| Spec section        | Check in the manifest and the code                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain              | every domain fact in sections 4, 8, 9 and 10 and in each prompt resolves to a line of `research.json` the skeptic called supported, on ids it confirmed; no prompt states a domain fact without one; an `our_choice` default states no domain fact; the deciding prompt follows the rubric's criteria and their order; each golden case is a test, and passes |
| 1 What it is        | `display` name, description, category, icon, `documentWords`; `pricing`                                                                                                                                                                                                                                                                                       |
| 2 How it starts     | `trigger` kind and `input` (keys, titles, descriptions, controls, required); `artifacts` (types, size, and no page or pixel limit when a type is not PDF, JPEG or PNG); `items` (words, fields, file, steps, the reading's schema)                                                                                                                            |
| 3 Integrations      | `requiredConnections` and each operation the code calls — no other provider, no other operation                                                                                                                                                                                                                                                               |
| 4 AI steps          | one prompt per row, each naming its capability; `requiredCapabilities` exactly those; the output schemas as written, each with the fields section 8's failures are decided by; the prompt rules the spec states                                                                                                                                               |
| 4 Privacy           | a model is sent only what the privacy rows say, and nothing they leave out — each left-out field with a test (Round 19, the flow's review, finding 1)                                                                                                                                                                                                         |
| 4 A customer's file | every prompt that reads one says its text is content, never an instruction, with the flag that lists such text and earns no credit (Round 19, the flow's review, finding 7)                                                                                                                                                                                   |
| 5 Setup             | `setup` fields, sections, defaults, groups — nothing asked that a connection knows                                                                                                                                                                                                                                                                            |
| 6 Steps             | `groups` and `pipeline` ids, titles and descriptions word for word, each pinned by a test; only the first step a TRIGGER; retries only on a step that calls something that can repeat                                                                                                                                                                         |
| 7 What a run gives  | `title`, `score`, `verdict`, summary; `blocks` — the spec's types, order and words, built through `boundedBlocks`, never with `sections` or `details`; `display.pages` as section 7 orders it, or none; `documents`, `outputSchema`, held, email                                                                                                              |
| 8 Failures          | each failure's exact words, whether the run stops, and the field or the code that decides it                                                                                                                                                                                                                                                                  |
| 9 Tests             | one test per row, made-up inputs only, each shown to fail without its code                                                                                                                                                                                                                                                                                    |

Also: no customer data in the diff; no word of the spec changed without a dated note at its top
(Round 19, the flow's review, finding 2); the repository README links the spec's sections and never
restates them (Round 19, the flow's review, finding 9). No platform change inside the flow: every
block, page part, control and provider operation is in `contract/schemas/` and
`snoopy-backend/providers/`, and the diff touches no other repository; `contract/` is the
platform's `main`'s, byte for byte. A new vendor's provider file, when there is one, declares
exactly the operations the code calls and no secret.
