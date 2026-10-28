# <Flow name>: spec

**Approved:** <YYYY-MM-DD, the owner's words> · **Version:** v<n> · **Words:** `words.md` beside this
spec, every word both clients show · **Research:** `research.md` beside this spec (<date>), its gaps
in section 11 · **Built in:** <PR link, once built>

Every limit below is the platform's: `snoopy-automations/contract/schemas/automation-manifest.json` and
`snoopy-automations/contract/schemas/automation-run-result.json`, and the rules beyond them in `snoopy-automations/contract/README.md`,
"What the platform refuses beyond the schema".
Nothing here is a customer's data: this repository is public.

## Domain (from research.md)

Unnumbered, so sections 1–11 keep their numbers. Each line carries the ids of `research.md` it rests
on, lines the skeptic called supported on sources it confirmed (`/create-flow` stage 1b); a fact the
brief does not carry is not written here.

| Part                   | From the brief, with its ids                                     |
| ---------------------- | ---------------------------------------------------------------- |
| Today's process        | five lines or fewer: who does what, what goes in, what comes out |
| The simplest pipeline  | five lines or fewer, on the twelve blocks                        |
| What an expert checks  | the criteria, in order                                           |
| The rubric             | the criteria as this flow scores or decides them                 |
| Vendors                | each vendor, and whether `snoopy-backend/providers/` declares it |
| Left to a person in v1 | what the first version does not decide                           |

## 1. What it is

| Field      | Value | Limit                                                                                                                                                                                       |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       |       | 80 characters; the document, then the job ("Invoice Processing", "Resume Screening")                                                                                                        |
| One line   |       | 200 characters: what it does, in a person's words                                                                                                                                           |
| Department |       | one of HR, Accounting, Finance, Legal, Compliance, Data, Operations, Sales, Marketing, Customer Support, IT, Engineering, Product, Procurement, Administration, Research; the flow joins it |
| Icon       |       | a name in `snoopy-mobile/lib/view/icon-registry.ts`; any other draws a placeholder in the app (section 10)                                                                                  |
| Price      |       | US dollars a month, cents at most; 0 unless the owner says                                                                                                                                  |

## 2. How it starts

| Field   | Value | Limit                                                                                                                                                                                                                                                                          |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trigger |       | manual, schedule (every 60 s to 366 days) or webhook; an event from an integration is not offered yet (section 10)                                                                                                                                                             |
| Files   |       | the types accepted, a size up to 100 MiB, PDF pages up to 1,000, an image's side up to 20,000 px; or none. The model reads PDF, JPEG and PNG (up to 3,750,000 bytes); another type (a Word file) is read as text by the flow, and its manifest declares no page or pixel limit |

Run inputs, asked when a person starts it (at most 16). A file field is never required: the platform
refuses a required file field (Round 19, the flow's lane).

| Key (camelCase) | Title | Description (200) | Control: toggle, money, text, email, artifact | Required |
| --------------- | ----- | ----------------- | --------------------------------------------- | -------- |

### Items — only when the flow keeps something its runs belong to (ADR-0046)

Made once, from a file, by owners and admins; every run names one; its runs are ranked by score.

| Field         | Value | Limit                                                                                                               |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Words         |       | one and many ("Job", "Jobs"); the runs' too ("Candidate", "Candidates"); 40 characters each                         |
| Fields        |       | 1–4: text (up to 200 characters), or a list (1–32 choices, a default, "Other" if typed names are kept)              |
| Named by      |       | one field                                                                                                           |
| Grouped by    |       | a list field, or none; the clients filter the items by it with the glass dropdown, A–Z                              |
| Verdict       |       | yes and no words ("Advance", "Decline") and the rule that picks one (score 60 or more); the item's tiles count them |
| File          |       | the file it is made from: its title and one line                                                                    |
| What AI keeps |       | the reading's JSON schema; shown as the item run's blocks (section 7)                                               |
| Its steps     |       | 1–8 step ids, reported while it is read; the screens show only "Reading…"                                           |

## 3. Integrations

Only providers in `snoopy-backend/providers/`, and only the operations each declares; anything else
is section 10.

| Provider | Why, as the person reads it (200) | Operations it calls | Required, or optional with None |
| -------- | --------------------------------- | ------------------- | ------------------------------- |

## 4. AI steps

As few calls as the job needs: each one is paid for, per document. Each failure of section 8 that a
model decides (not the document asked for, nothing readable on it) is a field of that step's JSON
schema, so the code stops on it rather than guessing (Round 19, the flow's lane). A prompt
that reads a customer's file treats its text as content to judge, never as an instruction: text that
tries to direct the reader is listed in a flag field and earns no credit
(Round 19, the flow's review, finding 7).

| Prompt id | Capability: document-extraction, classification, screening or summarization | What it reads | The JSON schema it answers with | Models, or the platform's default | Source: the research ids of every domain rule the prompt states |
| --------- | --------------------------------------------------------------------------- | ------------- | ------------------------------- | --------------------------------- | --------------------------------------------------------------- |

What a model is sent that no live flow sends yet, so the website's privacy policy ("Documents read by
AI") says it in the same round (web-privacy-fix.md):

| Privacy         | Value | Limit                                                                                                                                                |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sent to a model |       | each kind of document or text a model reads that no live flow sends yet, and from where; or none                                                     |
| Left out        |       | what the code removes before a call (a name, contact details, a location, personal links), each with a test (Round 19, the flow's review, finding 1) |
| The policy      |       | the sentence the privacy policy gains; none when nothing new is sent                                                                                 |

## 5. Setup questions

The fewest. What a connected integration knows is read from it, never asked.

| Section: connections, source, rules or notifications | Key | Title | Description (200) | Control: toggle, money, text, email, resource-picker or connection | Default | Required | Step group |
| ---------------------------------------------------- | --- | ----- | ----------------- | ------------------------------------------------------------------ | ------- | -------- | ---------- |

## 6. Steps a person sees

Groups, numbered, titles only on screen (2 to 6; title 40, description 120; the last may be the
platform's email):

| #   | Group id | Title | Description | Title when an integration is chosen |
| --- | -------- | ----- | ----------- | ----------------------------------- |

Steps, in order (at most 24; only the first is the trigger; title 80, description 200). A check
inside a group is a step, never a group of its own. A step retries only if it calls something that
can repeat — a model, an integration whose call is safe twice; a step of code alone never retries
(Round 19, the flow's lane, the `save` step):

| Step id | Kind: TRIGGER, AI STEP or ACTION | Title | Description | Group | Retries (only a step that calls something that can repeat) |
| ------- | -------------------------------- | ----- | ----------- | ----- | ---------------------------------------------------------- |

## 7. What a run gives

| Part           | Value | Limit                                                                                                                                                                 |
| -------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title          |       | 80 characters: what names the run on a list (a person's name); or none                                                                                                |
| Score          |       | 0–100, when runs are ranked; or none                                                                                                                                  |
| Summary        |       | one line, 200 characters                                                                                                                                              |
| Blocks         |       | what a person reads of a run, in order: the twelve types, at their bounds: `contract/README.md`, "A result's blocks"; a held run's too; never `sections` or `details` |
| Pages          |       | the order of the parts of the flow's, an item's, a run's and a file's page, from the manifest's closed set (`display.pages`); or none, today's order                  |
| Documents      |       | only for financial documents: the run-result schema's document (type, seller, number, lines, totals, payment, where it was recorded); else none                       |
| Document words |       | with documents only: one and many ("Invoice", "Invoices"), the manifest's `display.documentWords`; none reads "Document"                                              |
| Output         |       | the JSON schema of what the run keeps; never shown to a person (platform SYSTEM-MANIFEST §12.1 #67)                                                                   |
| Held           |       | when it waits for an approval, and the reason a person reads (200)                                                                                                    |
| Email          |       | the platform's own: a run's end and an approval, in its one standard; the flow sends none of its own unless this says why                                             |

## 8. When it fails

| When | What the person reads (200, plain) | The run stops, or goes on | Decided by: its field in section 4's schema, or the code | Source: research ids |
| ---- | ---------------------------------- | ------------------------- | -------------------------------------------------------- | -------------------- |

## 9. Test cases

Made-up inputs only. The research brief's golden cases first, then the rest.

| Input | What the run must give | Source: research ids |
| ----- | ---------------------- | -------------------- |

## 10. Needs the platform first

Only a provider, or an operation, `snoopy-backend/providers/` does not declare: one provider file,
built with the owner's credentials and merged before this flow
(`.claude/skills/create-flow/templates/order.md`, step 1). Anything else sections 1–8 need that the
platform does not offer is a platform change — a block, a page part, a question form or a target
(the platform's ADR-0048 decision 12), and a control, a capability, a trigger, a department or an
icon (a platform round under v3: a flow has no platform lane, 29.3.2): `/create-flow` stops, and
this flow waits for that round.

Each vendor the research's vendors lens found is here with its provider file, or "to add".

| What | Repository | The change |
| ---- | ---------- | ---------- |

## 11. Open questions

A gap of the research is written `Unknown — not found (research.md, Gaps)`. A default no confirmed
source carries, whatever its kind, is "a person decides" unless the owner kept its proposal at
stage 1b (the owner's words and the time beside it).

| Question | Proposed default |
| -------- | ---------------- |
