# <Flow name>: spec

**Approved:** <YYYY-MM-DD, the owner's words> · **Version:** v<n> · **Built in:** <PR link, once built>

Every limit below is the platform's: `contract/schemas/automation-manifest.json` and
`contract/schemas/automation-run-result.json`, and the rules beyond them in `contract/README.md`,
"What the platform refuses beyond the schema".
Nothing here is a customer's data: this repository is public.

## 1. What it is

| Field      | Value | Limit                                                                                                                                                                                       |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       |       | 80 characters                                                                                                                                                                               |
| One line   |       | 200 characters: what it does, in a person's words                                                                                                                                           |
| Department |       | one of HR, Accounting, Finance, Legal, Compliance, Data, Operations, Sales, Marketing, Customer Support, IT, Engineering, Product, Procurement, Administration, Research; the flow joins it |
| Icon       |       | a name in `snoopy-mobile/lib/view/icon-registry.ts`; any other draws a placeholder in the app (section 10)                                                                                  |
| Price      |       | US dollars a month, cents at most; 0 unless the owner says                                                                                                                                  |

## 2. How it starts

| Field   | Value | Limit                                                                                                              |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| Trigger |       | manual, schedule (every 60 s to 366 days) or webhook; an event from an integration is not offered yet (section 10) |
| Files   |       | the types accepted, a size up to 100 MiB, PDF pages up to 1,000, an image's side up to 20,000 px; or none          |

Run inputs, asked when a person starts it (at most 16):

| Key (camelCase) | Title | Description (200) | Control: toggle, money, text, email, artifact | Required |
| --------------- | ----- | ----------------- | --------------------------------------------- | -------- |

## 3. Integrations

Only providers in `snoopy-backend/providers/`, and only the operations each declares; anything else
is section 10.

| Provider | Why, as the person reads it (200) | Operations it calls | Required, or optional with None |
| -------- | --------------------------------- | ------------------- | ------------------------------- |

## 4. AI steps

As few calls as the job needs: each one is paid for, per document.

| Prompt id | Capability: document-extraction, classification, screening or summarization | What it reads | The JSON schema it answers with | Models, or the platform's default |
| --------- | --------------------------------------------------------------------------- | ------------- | ------------------------------- | --------------------------------- |

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
inside a group is a step, never a group of its own:

| Step id | Kind: TRIGGER, AI STEP or ACTION | Title | Description | Group | Retries (only a step safe to repeat) |
| ------- | -------------------------------- | ----- | ----------- | ----- | ------------------------------------ |

## 7. What a run gives

| Part           | Value | Limit                                                                                                                                           |
| -------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary        |       | one line, 200 characters                                                                                                                        |
| Details        |       | up to 20 lines, a label of 40 and a value of 200                                                                                                |
| Documents      |       | only for financial documents: the run-result schema's document (type, seller, number, lines, totals, payment, where it was recorded); else none |
| Document words |       | with documents only: one and many ("Invoice", "Invoices"), the manifest's `display.documentWords`; none reads "Document"                        |
| Output         |       | the JSON schema of what the run keeps; never shown to a person (platform SYSTEM-MANIFEST §12.1 #67)                                             |
| Held           |       | when it waits for an approval, and the reason a person reads (200)                                                                              |
| Email          |       | the platform's own: a run's end and an approval, in its one standard; the flow sends none of its own unless this says why                       |

## 8. When it fails

| When | What the person reads (200, plain) | The run stops, or goes on |
| ---- | ---------------------------------- | ------------------------- |

## 9. Test cases

Made-up inputs only.

| Input | What the run must give |
| ----- | ---------------------- |

## 10. Needs the platform first

Anything sections 1–8 need that the platform does not offer yet: a control, a capability, a
trigger, a department, an icon, a provider or an operation. Each is built and live before this flow.

| What | Repository | The change |
| ---- | ---------- | ---------- |

## 11. Open questions

| Question | Proposed default |
| -------- | ---------------- |
