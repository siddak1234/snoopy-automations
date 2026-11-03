# ICD-10 Code Check: words list

**Approved with the spec:** 2026-10-28 ~21:43Z, the owner: "approved." (the words as shown on the screens, and section 3's client words) · **Spec:** `README.md` beside this file

Every word a person reads on either client for this flow: one set, both clients. The flow's own
words live in its manifest and its blocks (the spec, sections 1–8), and the clients draw them as the
platform sends them. This list gathers them as the screens read them, for the owner's approval, and
holds the sentences the code writes into a run (the checks' and the failures'), which the review
and the failure drill read here.

Plain words: the fewest, titles only, no jargon; "flow" and "department", never "automation",
"team" or "project". A word changed after the approval goes back to the owner with a dated note at
the spec's top.

## 1. The flow's words — in the spec

| Screen                                     | The spec's section               |
| ------------------------------------------ | -------------------------------- |
| The catalog card                           | 1 (name, one line, department)   |
| Starting a run                             | 2 (run inputs)                   |
| Setting it up                              | 5 (the specialties)              |
| The numbered steps, and the steps of a run | 6                                |
| A run's results                            | 7 (title, summary, blocks, held) |
| When it fails                              | 8                                |

## 2. The sentences the code writes into a run

The check each comes from is the spec's section 7. `{code}`, `{title}` and `{quote}` are filled
from the run.

| Where                           | The words                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Verdicts (table, column 2)      | Keep · Change · Add · Remove · Move up · Ask the doctor; after the review: Accepted · Denied                                                                                                                       |
| Suggested (table, column 3)     | {code} · {title} · Remove · Move up                                                                                                                                                                                |
| G1                              | {code} is not a complete 2027 code.                                                                                                                                                                                |
| G3                              | The note supports a more exact code.                                                                                                                                                                               |
| G4, a change                    | The note says this is uncertain, so the sign or symptom is coded instead.                                                                                                                                          |
| G4, an ask                      | The note says this is uncertain, and no sign or symptom is written.                                                                                                                                                |
| G5, staff                       | Only staff who are not the provider mention it.                                                                                                                                                                    |
| G5, this visit                  | The note doesn't show it was assessed or treated at this visit.                                                                                                                                                    |
| G6                              | No line in the note supports this code.                                                                                                                                                                            |
| G7                              | The note supports this, and it isn't on the chart.                                                                                                                                                                 |
| K1                              | Kidney failure (N18.6) is coded, so no stage code goes beside it.                                                                                                                                                  |
| K2, a change                    | The patient is on dialysis, so dialysis status (Z99.2) is added.                                                                                                                                                   |
| K2, an ask                      | Kidney failure is coded. If the patient is on dialysis, add Z99.2.                                                                                                                                                 |
| K3                              | The kidney disease stage isn't in this note. An earlier visit may have it.                                                                                                                                         |
| L1                              | High blood pressure with kidney disease is coded together (I12), with the stage code after it.                                                                                                                     |
| L2                              | High blood pressure with heart and kidney disease is coded together (I13).                                                                                                                                         |
| L3                              | {code} goes before the kidney disease stage code.                                                                                                                                                                  |
| T1                              | The code table says: {the table's own note}                                                                                                                                                                        |
| Quote label                     | From the note                                                                                                                                                                                                      |
| Metric labels                   | Kept · Changes · Ask the doctor                                                                                                                                                                                    |
| Section title, a change         | {code} → {suggested}                                                                                                                                                                                               |
| Section title, the asks         | Ask the doctor                                                                                                                                                                                                     |
| Patient (block 1)               | Patient; columns Detail · Value; rows Name · Date of birth · Sex · Record number · Visit date · Provider                                                                                                           |
| A decision's label (the review) | {code} → {suggested}, the suggested being {code} · {title}, Remove or Move up; Add {code}                                                                                                                          |
| Table titles                    | Code · Verdict · Suggested; Codes to enter: Code · Description                                                                                                                                                     |
| Setup                           | Specialties: "The specialties your clinic treats. Their codes are listed first when a code is picked."; choices Nephrology · Internal medicine · Cardiology · Endocrinology · Family practice · Geriatric medicine |
| Badges                          | All codes supported · {a} accepted · {d} denied                                                                                                                                                                    |
| Directions (block 6)            | Text in the note tries to direct the reader: “{quote}”                                                                                                                                                             |
| No visit date                   | Visit date not on the note: checked with today's code table.                                                                                                                                                       |
| Footer (block 7)                | Checked against the {table} code set. Suggestions only: you accept or deny every change.                                                                                                                           |
| Held reason                     | {c} changes need your review.; the April 2026 hold: This visit is between Apr 1 and Sep 30, 2026. Check which 2026 code table applies.                                                                             |
| Run title                       | {patient name} · {date}; Visit · {date}; Visit note                                                                                                                                                                |
| Summary                         | {n} codes · all supported; {n} codes · {c} to review; {n} codes · {a} accepted · {d} denied                                                                                                                        |
| More than 40 changes            | This note has more than 40 changes to review. Add one visit at a time. (also more than 40 codes on the note)                                                                                                       |
| Failures                        | the spec's section 8, word for word                                                                                                                                                                                |

## 3. The clients' own words — the platform round's (section 10)

The two platform features this flow waits for add these words to both clients, copied word for word.

| Screen           | Where on it                             | The words, with {placeholders}                               | Shown when                             | Who sees it                                  |
| ---------------- | --------------------------------------- | ------------------------------------------------------------ | -------------------------------------- | -------------------------------------------- |
| Set up           | a several-choice dropdown, closed       | {first}, {second}; {n} chosen (three or more); Choose (none) | always                                 | owners and admins                            |
| Set up           | a required dropdown left empty, on save | Choose at least one.                                         | on save                                | owners and admins                            |
| A held run       | each change's row                       | {label} · {detail}; Accept · Deny                            | the run waits for a review             | everyone; the pills to those who may approve |
| A held run       | the save                                | Save review                                                  | every row answered                     | those who may approve                        |
| A held run       | before every row is answered            | Accept or deny each change.                                  | a row unanswered                       | those who may approve                        |
| A held run       | to a member                             | Only an owner or admin can review this.                      | always                                 | members                                      |
| Approvals        | the card                                | Review {n} changes                                           | the run waits for a review             | those who may approve                        |
| A run, Approvals | after the review                        | {a} accepted · {d} denied                                    | the review is saved                    | everyone                                     |
| A held run       | the save failed                         | The review wasn't saved. Try again.                          | the platform refused or did not answer | those who may approve                        |
| The email        | the line                                | {n} changes to review                                        | the run waits for a review             | those who may approve                        |

## 4. v2 (2026-11-01)

The owner's go, 2026-11-01 ~04:45Z, after the nine screens, and ~06:15Z for the batch; the spec's
"v2 (2026-11-01)" says what each line serves. Every word of sections 1–3 that v2 does not replace
stays. **The lines below not from the screens** (the task's and the session's) **were approved by the
owner on 2026-11-01 ~18:58Z**, shown as written (question form): "Approve all (Recommended)". The
"Whose" column still says who wrote each line.

| Where                                    | The words                                                                                                                                                                                       | Whose                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Starting a run, the file field's group   | Add visit notes                                                                                                                                                                                 | the screens                                           |
| Starting a run, the file field           | Visit notes; its line: For doctors and coders.                                                                                                                                                  | the task                                              |
| The catalog card, who it is for          | For doctors and coders.                                                                                                                                                                         | the screens                                           |
| Setup, the specialties                   | Specialties                                                                                                                                                                                     | the screens                                           |
| Setup, the NPI                           | NPI; its line: Fills your specialties when none are picked. Optional.                                                                                                                           | the screens, with "when none are picked" (below)      |
| The review, each change (a decision)     | the label: {code} → {suggested} (Add {code}); the group: {patient name} · {visit date}                                                                                                          | the screens                                           |
| The review, each change's why (detail)   | Difference: "{words only in the first}" vs "{words only in the second}" · From the note: "{quote}" · Rule: {the check's rule}                                                                   | the screens                                           |
| The why's rule, G3                       | most specific code the note shows                                                                                                                                                               | the screens                                           |
| The why's rule, G1                       | complete code from the {table} table (the visit's table: 2026, April 2026 or 2027)                                                                                                              | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, G4                       | uncertain diagnosis: code the sign or symptom                                                                                                                                                   | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, G7                       | code what the note supports                                                                                                                                                                     | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, K1                       | N18.6 takes no stage code                                                                                                                                                                       | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, K2                       | dialysis: add Z99.2                                                                                                                                                                             | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, L1                       | blood pressure + kidney disease: I12, then the stage                                                                                                                                            | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, L2                       | blood pressure + heart + kidney: I13                                                                                                                                                            | the owner's, 2026-11-03 (item 5)                      |
| The why's rule, L3                       | {code} before the kidney stage                                                                                                                                                                  | the owner's, 2026-11-03 (item 5)                      |
| The batch run, its summary and its block | {files} files · {pages} pages · {visits} visits · {set aside} set aside; 1 in the singular (1 file · 1 page · 1 visit)                                                                          | the task, the singular the session's                  |
| The batch's unit words                   | Visit, Visits                                                                                                                                                                                   | the task                                              |
| A visit's run past the review's limits   | This visit has more codes than one run can review.                                                                                                                                              | the session's, 2026-11-01                             |
| An upload past one batch's limits        | This upload has more visits than one batch can hold. Upload fewer files at a time.                                                                                                              | the session's                                         |
| An upload not sorted before the deadline | This upload has more pages than one run can sort in time. Upload fewer files at a time.                                                                                                         | the session's                                         |
| The timeline, the NPI lookup failed      | Specialties not read from your NPI                                                                                                                                                              | the session's                                         |
| The timeline, the memory not written     | Codes saved. Your clinic's choices were not remembered for next time.                                                                                                                           | the session's                                         |
| Setup, the clinic's learning             | Learn from this clinic's reviews; its line: On by default. Each accepted or denied change, without names, numbers or dates, guides later picks. Turn it off to stop and clear what was learned. | the owner's L1–L5, 2026-11-01; the line the session's |

The screens' NPI line read "Fills your specialties. Optional."; the NPI is read at run time (the
platform round sets nothing up from a connected app), so the line says when it fills them. The
why's labels are the owner's screens' ('Difference: "unspecified" vs "3a"', 'From the note: "CKD
stage 3a"', 'Rule: most specific code the note shows'); the code says that line exactly for
N18.30 → N18.31. The screens show one rule, G3's; every other rule a decision carries is the
owner's short words (2026-11-03, item 5: "Recommended"). A check only an ask or a Keep carries
(G2, G5, G6, K3, T1) has none: an ask keeps its sentence (section 2). The batch's step titles and
descriptions are the manifest's, the session's. The learning toggle is on by default: an owner or
admin, who edits the setup, turns it off to clear the clinic's examples (the next visit's save
clears them).

## 5. v3 (2026-11-03)

**Dated 2026-11-03: these words await the owner's approval** (the session's Stage 1 spec, from the
owner's TestFlight build 34 feedback; the spec's "v3" says what each line serves). Every word of
sections 1–4 that v3 does not replace stays.

| Where                    | The words                      | Whose                  |
| ------------------------ | ------------------------------ | ---------------------- |
| Setup, the section names | NPI · Specialty · Integrations | the session's, from F3 |
