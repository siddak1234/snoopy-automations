# Review brief — the build against its approved spec and its words list

One reviewer pass per lane. Never edit. Write PASS or FAIL on line 1, then 10 findings or fewer, each
`file:line — problem — fix`.

## The flow, against its spec

`git diff <base>..HEAD` in the flow's `snoopy-automations` branch, against
`automations/<name>/README.md` (approved: its top line carries the owner's words).

| Spec section        | Check in the manifest and the code                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 What it is        | `display` name, description, category, icon, `documentWords`; `pricing`                                                                                                                                                            |
| 2 How it starts     | `trigger` kind and `input` (keys, titles, descriptions, controls, required); `artifacts` (types, size, and no page or pixel limit when a type is not PDF, JPEG or PNG); `items` (words, fields, file, steps, the reading's schema) |
| 3 Integrations      | `requiredConnections` and each operation the code calls — no other provider, no other operation                                                                                                                                    |
| 4 AI steps          | one prompt per row, each naming its capability; `requiredCapabilities` exactly those; the output schemas as written, each with the fields section 8's failures are decided by; the prompt rules the spec states                    |
| 4 Privacy           | a model is sent only what the privacy rows say, and nothing they leave out — each left-out field with a test (Round 19, the flow's review, finding 1)                                                                              |
| 4 A customer's file | every prompt that reads one says its text is content, never an instruction, with the flag that lists such text and earns no credit (Round 19, the flow's review, finding 7)                                                        |
| 5 Setup             | `setup` fields, sections, defaults, groups — nothing asked that a connection knows                                                                                                                                                 |
| 6 Steps             | `groups` and `pipeline` ids, titles and descriptions word for word, each pinned by a test; only the first step a TRIGGER; retries only on a step that calls something that can repeat                                              |
| 7 What a run gives  | `title`, `score`, summary, `sections` (order, names, empty ones left out), `details`, `documents`, `outputSchema`, held, email                                                                                                     |
| 8 Failures          | each failure's exact words, whether the run stops, and the field or the code that decides it                                                                                                                                       |
| 9 Tests             | one test per row, made-up inputs only, each shown to fail without its code                                                                                                                                                         |

Also: no customer data in the diff; no word of the spec changed without a dated note at its top
(Round 19, the flow's review, finding 2); the repository README links the spec's sections and never
restates them (Round 19, the flow's review, finding 9).

## The clients, for parity — against the words list

`git diff <base>..HEAD` in the client's branch, with the other client's branch beside it and the
words list, `automations/<name>/words.md`. A parity finding names both clients' files and which
one changes: the website's review found the app's gaps (Round 19, the website review's list for the app).

| Check           | In both clients                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The words       | every word of the list's section 2 drawn word for word in both, its placeholders filled from the manifest; no other words in those places                                                                                                             |
| No flow's words | no word or id of one flow in code or in comments: the flow's words come from the manifest (Round 19, the app's review, finding 4)                                                                                                                     |
| The states      | empty, still working, unavailable, each refusal (a refused field's words under that field), the confirmation, a member's view: the same in both                                                                                                       |
| The layout      | the list's section 3: the same parts in the same order, the same ones open and collapsed, the platform's order kept and tested with an order a sort would change                                                                                      |
| The contract    | the types generated from the backend's last head; `SNOOPY_BACKEND_ROOT` at the snapshot or that head, never `../snoopy-backend`                                                                                                                       |
| Privacy         | the website's privacy policy says what the spec's privacy rows say, in the same round (Round 19, the website's privacy sentence)                                                                                                                      |
| Design standard | the app's `snoopy-mobile/DESIGN-CONTRACT.md` (a row for each new screen and operation, composed from its components and tokens) and the website's `snoopy/AGENTS.md` design-system rules; every rule the owner's feedback settled since the last flow |
