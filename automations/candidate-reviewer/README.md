# Resume Screening (`candidate-reviewer`): spec

**Approved:** 2026-10-24 — the design by the owner's five answers (below) and "now continue and complete in parallel"; the words as shown to the owner, by the owner's reply "complete" when asked for "words approved" (~06:10Z) · **Version:** v5 · **Built in:** v1 in [#52](https://github.com/siddak1234/snoopy-automations/pull/52) (`314b619`), registered by the platform's FORTY-FIRST pin; v2 in [#57](https://github.com/siddak1234/snoopy-automations/pull/57) (`ea2a900`), registered by the platform's FORTY-SECOND pin and served since its read-back, 2026-10-25 07:07:47Z

**v3's words approved after v3 went live:** 2026-11-04, before 18:36:45Z, the owner: "F1. approve" — the Contact row "Name" and `Exact words: "…"` under the name, the email and the phone (§7), as built, no word changed. v3 was already served on both hosts: Flow CD run 41881756507 (this repository's `6ad084c`) served it in its attempt 1, which ended at 17:57:36Z (snoopy-backend SYSTEM-MANIFEST §6), before the approval — against the create-flow skill's stage 2, which registers nothing before it.

**v2, 2026-10-24 (the owner's decisions on build 28's feedback):** the name "Resume Screening"
(§1; v1 is "Candidate Reviewer"); the department options A–Z, "AI" added among them, HR still the
default (§2); a verdict on each candidate, "Advance" at a score of 60 or above and "Decline" below
(§7), a label from the score alone: a person decides (§11). The job's reading, the prompts, the
steps and every other word are v1's, so a job made on v1 serves v2's runs; v1 is served beside v2
until it is retired. It needs the platform's build 28 contract first (§10).

**v2, 2026-10-25 (build 28's F8: "If there is a url that should be in the section"):** a resume's
links are also those its file links to behind a word, such as "LinkedIn" (§4), each named by its
site (§7); v2's output schema describes the links so (v1's: "Each web address printed").

**v3, 2026-11-04 (the owner's Q1 and Q2 of 2026-11-03, "continue with recommended"):** the
manifest is v2's but for its version and its own container. **Q1, the exact words:** the resume's
read gives the words the name, email and phone were read from, as printed (`extract-resume` v2, rule
9), and Contact shows each under its value — "Exact words: "…"" — a Name row now opening Contact
(§7), so a resume keeps 36 links, not 37. A Word resume's words are checked against its text
(white space read as one space); words its text does not hold are not trusted, and the value shows
with no quote line. A PDF's or a photo's words are shown as the model read them, unchecked, for a
person to compare with the file. **Q2, an unusable answer:** an answer off its schema is asked once
more with the fault line; a second miss at any of the three AI steps ends the run "The AI's answer
couldn't be used. Try a clearer file." (§8): no hold.

**v4, 2026-11-06 (the owner's items 11–13 on build 37, 2026-11-05; "complete all", 2026-11-06):**
the manifest is v3's but for its version and its own container (origin
`http://candidate-reviewer-v4.autom8x.internal:8080`, service account `candidate-reviewer-v4`). Each
run's result is sent as **blocks** in place of sections (§7). Item 11: "What is this exact words. It
should be bolded the details not this weird schema." Item 12: "Every third party link should have a
logo button pill with the logo and next to it the user name. That means strip the first half of the
url as well." Item 13: "It should be bolded Name / Then the name of the candidate / Bolded email /
Then the email". The words, approved by "complete all" (2026-11-06): **"Name", "Email", "Phone",
"Location"**, each a Contact row's title over its value, and **"Links"**, the owner's word for the
buttons (a `links` block carries no title, so the flow sends no such string).

| v4                     | What a person sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A candidate            | one group, "Candidate details", of sections in v3's order (Contact, Experience, Education, Projects, Certifications, Skills, Languages, Why this score); a section with nothing in it left out; no top-level metric or badge, so the run email stays as it is                                                                                                                                                                                                                                                                                                                                                      |
| Contact                | rows "Name", "Email", "Phone", "Location", each its label as the title and the value as the text, an empty one left out; no "Exact words" line; then the resume's links as buttons                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| A link button          | the logo by its host: linkedin.com, github.com, huggingface.co, x.com and twitter.com (both X), a subdomain counted; the label the username (linkedin.com/in/{id} → id; the others' /{user} → user); any other site, or a named one whose address names no user, the logo "site" and the address without "https://", "www.", a query or a trailing slash; at most 40 characters as the platform counts them, UTF-16 units, an emoji two (else the first that fit in 39 and "…", no emoji split); `http://` sent as `https://`; eight buttons a block (`BLOCK_LIMITS.linksItems`), as many blocks as the links take |
| Projects               | a row each, its name the title and its description the text; each project's link a button by its host, labelled by the path after it ("AkulAggarwal2/repo")                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The other sections     | v3's rows (title, subtitle, text), unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A job's "What AI read" | four sections at the top level: Must-haves, Nice to have, Responsibilities as v3, and Details as rows "Location", "Type", "Years", "Education", "Pay", each its label over its value                                                                                                                                                                                                                                                                                                                                                                                                                               |

**v4's gaps, recorded:**

- **The exact words are kept nowhere.** v3 kept them only in the sections it drew (the run's
  `result_sections`); they were never in the output, and the model-call ledger keeps no answer
  text. v4 still reads them and runs the Word check (`quotesOf`, `trusted`, in `read-resume`'s
  state, `state.quotes`, tested in `automations/candidate-reviewer/test/quotes.test.ts`), and shows
  and keeps them nowhere after the run: nothing outside the screen ever read them.
- **A job's reading moves to blocks.** With blocks, a v4 job's `items.sections` stays empty and the
  platform's `listItems` carries no sections for it; its reading is on the item read with
  `shape=blocks`. Client readers of an item's `.sections`: none found in either client (2026-11-06).
- **v4 is served only when a version slot is free**: the hosts serve at most six versions
  (`FLOW_SERVED_SLOTS=6`, the platform's SYSTEM-MANIFEST); one is retired with the owner before
  this merges. v3's runs keep their sections, drawn by the platform as before.

**v5, 2026-11-14 (the owner's items 1 and 4 on build 43; "Yes to all 3", 2026-11-14):** the
manifest is v4's but for its version, its own container (origin
`http://candidate-reviewer-v5.autom8x.internal:8080`, service account `candidate-reviewer-v5`) and
its resume field **required** (§2): the platform refuses a run without a file before it starts,
since its ADR-0030 amendment of 2026-11-14 allows a required file field. A run that still names no
file stops in its own words, "Add the resume as a PDF, Word file or photo." (§8), apart from a file
that could not be read. Item 1: "I pressed start without uploading anything. It took me to
activity. If there is no file uploaded then it shouldnt start. This is a basic requirement for a
button. " Item 4: "I believe this spdcific error was because no file existed. Ensure there is
differentiation between errors and their types." The new words are the design's, shown to the
owner with the round's plan. v4's container keeps its pinned image until it is retired
(`/retire-version`); v4's runs keep v4's words. It merges only after the platform's build-43 pull
request is merged and deployed (Flow CD runs the platform's validator, which until then refuses a
required file field).

**Changed since the words were shown to the owner (2026-10-24):** the step descriptions "Scored
against the job, with reasons." and "Added to the job's list, highest score first." (were "posting");
a fourth failure, "This candidate's job has not been read yet." (§8; the platform refuses such a run
first); "Why this score" also lists flags, among them "years not shown" and "Text that tries to
direct the reader: "…"" (§4, §7); the resume field was not marked required until v5 (§2: the platform
then refused a required file field); `save` declares no retry (§6); what the scoring call is never sent (§4). At
v1, every word on the screens the owner was shown is unchanged; what v2 changed is in the notes
above. v3 adds two words, NEW, ~~awaiting the owner's approval~~ approved 2026-11-04 after v3 went live (this spec's top): the Contact row "Name" and
`Exact words: "…"` under the name, the email and the phone (§7).

Every limit below is the platform's: `contract/schemas/automation-manifest.json` and
`contract/schemas/automation-run-result.json`, and the rules beyond them in `contract/README.md`,
"What the platform refuses beyond the schema".
Nothing here is a customer's data: this repository is public. Every job description and resume
named below is made up.

The idea, the owner's words (2026-10-23): an org uploads a job description; AI reads it and keeps
what it read for that posting. "Add candidate" uploads a resume or CV; AI reads experience,
education, certifications and links, scores the candidate against the posting, and candidates are
sorted top to bottom. An org has departments, each with roles. Simple screens: the flow shows the
posting, its department and the steps to add a candidate; "upload a new job" opens a card to pick
the department and the role.

The owner's answers (2026-10-24): the department is "pre selected and then the free text. if free
text then save that name in case future jobs are uploaded to that name"; files "yes and add docs"
(PDF, JPEG, PNG and Word); the candidate page is "score, name then drop down menus within a
candidates page. like contact, experience, educations, projects, certs,..."; jobs and candidates are
added by "owners and admins for now"; the command is `/create-flow`. Name "Candidate Reviewer", HR.

## 1. What it is

| Field      | Value                                                            | Limit                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name       | Resume Screening                                                 | 80 characters                                                                                                                                                                               |
| One line   | Reads resumes and scores each candidate against the job posting. | 200 characters: what it does, in a person's words                                                                                                                                           |
| Department | HR                                                               | one of HR, Accounting, Finance, Legal, Compliance, Data, Operations, Sales, Marketing, Customer Support, IT, Engineering, Product, Procurement, Administration, Research; the flow joins it |
| Icon       | UserPlus                                                         | a name in `snoopy-mobile/lib/view/icon-registry.ts` (it is); the website draws no flow icon                                                                                                 |
| Price      | 0                                                                | US dollars a month, cents at most; 0 unless the owner says                                                                                                                                  |

## 2. How it starts

| Field   | Value                                                                                                                                     | Limit                                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger | manual: a person adds a candidate to a job                                                                                                | manual, schedule (every 60 s to 366 days) or webhook; an event from an integration is not offered yet (section 10)                          |
| Files   | PDF, JPEG, PNG or Word (.docx), up to 3,500,000 bytes; no page or pixel limit is declared, since Word is not a type the platform measures | a size up to 100 MiB, PDF pages up to 1,000, an image's side up to 20,000 px; the model reads only these three types, up to 3,750,000 bytes |

Run inputs, asked when a person starts it (at most 16):

| Key (camelCase) | Title  | Description (200)          | Control: toggle, money, text, email, artifact | Required                                                                                                         |
| --------------- | ------ | -------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| resumeFile      | Resume | A PDF, Word file or photo. | artifact                                      | yes: a run without it is refused before it starts (v5); v1 to v4 left it optional, as the platform then required |

The job the candidate is added to is not a question: "Add candidate" sits on the job's page, so the
run carries the job (section 10, items).

### Jobs — the flow's items (section 10: the platform does not have this yet)

A job is made once, from its job description; every candidate run belongs to one. Owners and admins
make jobs and add candidates; everyone in the workspace sees them.

| Field           | Value                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Words           | Job, Jobs; a run is a Candidate, Candidates                                                                                                                                                                                                                                                                                                       |
| Department      | a list, A–Z: the 16 department names and "AI" (Accounting, Administration, AI, Compliance, Customer Support, Data, Engineering, Finance, HR, IT, Legal, Marketing, Operations, Procurement, Product, Research, Sales), HR the default; then every name typed before; "Other" opens a text box, and a name typed there is offered for the next job |
| Role            | text, required, 80 characters; names the job                                                                                                                                                                                                                                                                                                      |
| Job description | a PDF, Word file or photo, required; the same file limits as a resume                                                                                                                                                                                                                                                                             |
| What AI keeps   | the role's requirements, read once (section 4, `extract-posting`), shown on the job                                                                                                                                                                                                                                                               |
| Grouped by      | department, on the flow's page                                                                                                                                                                                                                                                                                                                    |

## 3. Integrations

None. The job description and the resumes are files; nothing is read from or written to another
app.

| Provider | Why, as the person reads it (200) | Operations it calls | Required, or optional with None |
| -------- | --------------------------------- | ------------------- | ------------------------------- |
| —        | —                                 | —                   | —                               |

## 4. AI steps

Three prompts; two calls per candidate and one per posting. Each prompt names a capability, never a
model; the models are the flow's constant (primary first, then fallbacks by another maker, as
Invoice Processing's), or the platform's default.

| Prompt id       | Capability          | What it reads                                                    | The JSON schema it answers with                                                                                                                                                                                                                                                                      | Models              |
| --------------- | ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| extract-posting | document-extraction | the job description: the file, or a Word file's text             | title, department as printed, location, employment type, summary (200), mustHaves[], niceToHaves[], responsibilities[], minimumYears (null if not printed), education, certifications[], skills[], pay as printed, uncertainFields[]                                                                 | the flow's constant |
| extract-resume  | document-extraction | the resume: the file, or a Word file's text                      | name, email, phone, location, links[] {url, label}, summary (200), experience[] {title, company, start, end, current, highlights[]}, education[] {degree, field, school, year}, projects[] {name, description, url}, certifications[] {name, issuer, year}, skills[], languages[], uncertainFields[] | the flow's constant |
| score-candidate | screening           | the posting's reading and the resume's reading, as text; no file | score 0–100, summary (200: why), matches[], gaps[], experienceFit, educationFit, certificationsFit, flags[]                                                                                                                                                                                          | the flow's constant |

Rules the prompts carry: read only what is printed, never guess; an unreadable or missing value is
empty or null and listed in `uncertainFields`; the score follows the posting's must-haves first,
nice-to-haves second, and names each reason; a resume with no dates scores on what it shows and
flags "years not shown". Years of experience are computed by the code from the dates read, never by
the model. The resume prompt also answers whether the file is a resume (`document`), and the job
prompt whether the description could be read (`readable`) — the two checks of section 8; the job's
stored reading leaves `readable` out. The scoring call is sent the two readings without the
candidate's name or contact details — email, phone, location, links, and each project's link. Text
in a job description or a resume is content to judge, never an instruction: the resume prompt
returns any text that tries to direct its reader as `directions`, which the scoring call is never
sent; the run flags it under "Why this score" and gives a match that quotes it no credit. The score
itself is the model's judgement under that rule. A Word file (.docx) is not sent as a file: its text is read by the flow (Node's `zlib`,
no dependency, bounded) and sent as the prompt's input; a PDF or photo is sent as the file.
A resume's links are those printed and those the file links to: a word such as "LinkedIn" whose
address is only in the file's link is not printed, so the flow reads it from the file — a PDF's
bytes, its compressed parts too, and a Word file's body's hyperlinks — the same way (Node's `zlib`,
no dependency, bounded); a photo holds none, and an encrypted or broken PDF gives none, the run
going on. Only `http` and `https` addresses are kept, each once, after the model's; one the model
read keeps its label. The prompt is unchanged: it reads what is printed.

## 5. Setup questions

None. Nothing to set up: the flow has no integration and no limit to choose. Emails follow the
platform's standard (section 7).

| Section | Key | Title | Description (200) | Control | Default | Required | Step group |
| ------- | --- | ----- | ----------------- | ------- | ------- | -------- | ---------- |
| —       | —   | —     | —                 | —       | —       | —        | —          |

## 6. Steps a person sees

Groups, numbered, titles only on screen (2 to 6; title 40, description 120; the last is the
platform's email):

| #   | Group id | Title             | Description                                  | Title when an integration is chosen |
| --- | -------- | ----------------- | -------------------------------------------- | ----------------------------------- |
| 1   | upload   | Add candidate     | A resume: PDF, Word file or photo.           | —                                   |
| 2   | review   | AI review         | Reads the resume and scores it.              | —                                   |
| 3   | ranked   | Candidates ranked | Highest score first.                         | —                                   |
| 4   | email    | Run completed     | Done when the run succeeds. (platform email) | —                                   |

Steps, in order (at most 24; only the first is the trigger; title 80, description 200):

| Step id      | Kind    | Title            | Description                                               | Group  | Retries                                     |
| ------------ | ------- | ---------------- | --------------------------------------------------------- | ------ | ------------------------------------------- |
| receive      | TRIGGER | Resume received  | A PDF, Word file or photo arrives.                        | upload | no                                          |
| read-resume  | AI STEP | Resume read      | AI reads experience, education, certifications and links. | review | no                                          |
| check-resume | ACTION  | Resume checked   | Checks it is a resume and can be read.                    | review | no                                          |
| score        | AI STEP | Candidate scored | Scored against the job, with reasons.                     | review | no                                          |
| save         | ACTION  | Candidate saved  | Added to the job's list, highest score first.             | ranked | no: it calls nothing that could be repeated |

The job's own steps (section 10, items: `items.pipeline`), reported while a job is made; the screens
show only "Reading…", then the job:

| Step id      | Title                    | Description                        |
| ------------ | ------------------------ | ---------------------------------- |
| job-received | Job description received | A PDF, Word file or photo arrives. |
| read-job     | Job read                 | AI reads the role's requirements.  |
| save-job     | Job saved                | Ready for candidates.              |

## 7. What a run gives

| Part           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Limit                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Title          | the candidate's name, as read ("Jane Doe"); "Unnamed candidate" when none is printed; section 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 80 characters                                                                                      |
| Score          | 0 to 100 (section 10); the bands are the summary's words: 80+ Strong match, 60–79 Good match, 40–59 Partial match, under 40 Weak match                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integer                                                                                            |
| Verdict        | `positive` at a score of 60 or above, `negative` below; the words the screens show, `items.verdictWords`: "Advance" and "Decline"; the job counts its candidates by it; a job's own run gives none                                                                                                                                                                                                                                                                                                                                                                                                                                                              | one of two (section 10)                                                                            |
| Summary        | "Strong match · meets 3 of 3 must-haves"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | one line, 200 characters                                                                           |
| Sections       | v4: none, its blocks hold them (the table under v4 above). v3: collapsed rows, in this order: Contact (the name; email, phone, location, links; the name, email and phone each with "Exact words: "…"" under it when trusted — each by what it is, and a link only the file holds by its site: "LinkedIn", "GitHub", "Hugging Face", or the site's address without "www."); Experience (each role: "Senior Accountant · Acme", "2021 – now · 4 years", its highlights); Education; Projects; Certifications; Skills; Languages; Why this score (each must-have met or missing, each nice-to-have met, then any flags); a section with nothing in it is left out | up to 12 sections of up to 40 rows; section 10                                                     |
| Blocks         | v4: one group, "Candidate details", of the sections above as `list` rows and `links` buttons (the table under v4 above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the SDK's [`BLOCK_LIMITS`](../../packages/automation-sdk/src/blocks-limits.ts), the platform's own |
| Details        | none: the sections hold it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                  |
| Documents      | none: a resume is not a financial document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | only for financial documents                                                                       |
| Document words | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                  |
| Output         | the posting's reading, the resume's reading and the score, whole                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | never shown to a person (platform SYSTEM-MANIFEST §12.1 #67)                                       |
| Held           | never: nothing waits for approval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                  |
| Email          | the platform's own, at a run's end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the flow sends none of its own                                                                     |

A job's page lists its candidates highest score first, and counts them Advance and Decline
(section 10). The job shows what AI read, as
collapsed sections: Must-haves, Nice to have, Responsibilities, Details (location, type, years, education, pay); v4
sends them as blocks, each Details row its label ("Location", "Type", "Years", "Education", "Pay") over its value.

## 8. When it fails

| When                                                                                   | What the person reads (200, plain)                                 | The run stops, or goes on |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- |
| The file is not a resume (a receipt, a letter)                                         | This file does not look like a resume.                             | stops                     |
| The file cannot be read (blurred, empty, a blank scan)                                 | The file could not be read. Try a clearer PDF or photo.            | stops                     |
| The job description cannot be read                                                     | The job description could not be read. Try a clearer PDF or photo. | the job is not made       |
| A run whose job has no reading (the platform refuses such a run first; never expected) | This candidate's job has not been read yet.                        | stops                     |
| No file was added (the platform refuses such a run first, since v5)                    | Add the resume as a PDF, Word file or photo.                       | stops                     |
| The model's answer is off its schema twice, once asked again (v3, Q2)                  | The AI's answer couldn't be used. Try a clearer file.              | stops                     |
| The model refuses, or the plan's monthly calls are used up                             | the platform's own words for the refusal                           | stops                     |

## 9. Test cases

Made-up inputs only.

| Input                                                                                             | What the run must give                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A clear two-page PDF resume against a posting with three must-haves it meets                      | score 80 or more, Strong match, each must-have named under Why or Skills matched, 3 links listed         |
| A resume meeting one of three must-haves                                                          | a score under 60, the two missing must-haves under Why this score                                        |
| A photo of a one-page resume with no dates                                                        | a score, Experience "years not shown", the flag listed                                                   |
| A receipt uploaded as a resume                                                                    | fails: This file does not look like a resume.                                                            |
| A blank page                                                                                      | fails: The file could not be read. Try a clearer PDF or photo.                                           |
| A run whose input names no file (v5; the platform refuses it first)                               | fails: Add the resume as a PDF, Word file or photo.                                                      |
| A job description photo                                                                           | the job made: title, must-haves and nice-to-haves read; Job saved                                        |
| A PDF resume whose LinkedIn, GitHub and Hugging Face are words, their addresses only in its links | Contact lists the three, v4 as buttons with the LinkedIn, GitHub and Hugging Face logos and the username |
| A Word resume with a word linked to a site, its address not printed                               | Contact lists that link, v4 named by its address, after those the model read                             |

## 10. Needs the platform first

Everything here is built and live before this flow (Round 19, decision B: all four repositories).

| What                                                                                                                                                                                                                          | Repository                                  | The change                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A flow's **items** (here jobs): the manifest's `items` block — words, run words, fields (text; select with options and "Other"), a file, the item's own steps and its reading's schema                                        | `snoopy-backend`                            | schema, validator and its tests; `contract/schemas` vendored here                                                                                      |
| Items stored and served: make (with its file → the item's run), list, read, archive; an item's runs by score                                                                                                                  | `snoopy-backend`                            | a catalog table and Edge routes, team-gated as a run start is, audited, idempotent                                                                     |
| A run belongs to an item; the item's reading reaches each later run; a result carries a **title**, a **score** and **sections**                                                                                               | `snoopy-backend`                            | `runs`: `itemId` on a run, item runs, the result's three new fields; the run and the list on the wire; owners and admins only for items and their runs |
| v2: a run's **verdict** and its words — the manifest's `items.verdictWords`, a success's `verdict`, an item's counts of each (Round 19, build 28)                                                                             | `snoopy-backend`, `snoopy`, `snoopy-mobile` | schema, validator, the run and the item on the wire; `contract/schemas` vendored here; the screens name it with the flow's words                       |
| Word files: the clients' pickers take what the flow accepts                                                                                                                                                                   | `snoopy-backend`, `snoopy`, `snoopy-mobile` | the run input field publishes `acceptedContentTypes`; the pickers read it                                                                              |
| The screens: jobs on the flow page (by department); the Upload job card (department, role, file); the job page with candidates ranked; title, score and collapsed sections on the run page; the `select` control with "Other" | `snoopy`, `snoopy-mobile`                   | drawn from `items.words` and the manifest, never from this flow's id (the no-flow-code tests stay)                                                     |
| The privacy policy's "Documents read by AI" names what Invoice Processing reads; it must also say job descriptions and resumes are read                                                                                       | `snoopy`                                    | one section                                                                                                                                            |

## 11. Open questions

| Question                                             | Proposed default                                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The score bands                                      | 80+ Strong, 60–79 Good, 40–59 Partial, under 40 Weak                                                                                                |
| The same person added twice to one job               | two candidates, both listed; no merge                                                                                                               |
| Is the score, or its Advance or Decline, a decision? | no: a recommendation with reasons, and Advance or Decline a label from the score alone (§7); a person decides (rules on AI in hiring vary by place) |
| A job typed instead of uploaded                      | not offered: a job description file is required                                                                                                     |
| Old Word files (.doc, before 2007)                   | not accepted: only .docx; a .doc is saved again as .docx or PDF                                                                                     |
| The run email for each candidate                     | as every flow today: the platform's email at each run's end (a toggle to turn it off is a later change)                                             |

## How the code does it

`candidate-reviewer` — **Resume Screening** from v2 (**Candidate Reviewer** at v1), in HR — reads a
job description once into the job's reading, then reads each candidate's resume and scores it
against that reading (the platform's BUILD-PLAN Phase 28, Round 19). It is the first flow with
items (the repository README, "A flow's items"): a job is its item, a candidate its run. What it
does, in the words a person reads, is this spec, above, the build's source of truth word for word.
This section moved here from the repository README in Round 21, so a change to the flow asks for
this file in the same change (`docs/docs-map.json`). It is one of the two live flows on
`defineAutomation`, exempt from the new flows' standards; its after-pilot versions, v3 to v5, stay on it
and take Q2's re-ask alone. Where the code does it:

- **v5, the version this code serves**: `SERVED_VERSIONS` in
  `automations/candidate-reviewer/src/automation.ts`, whose `servedManifests` keeps it alone of the
  manifests `define` is given and refuses when none is left, as Invoice Processing's does; its
  Dockerfile copies only `manifests/candidate-reviewer.v5.json`, which `automations/candidate-reviewer/test/manifest.test.ts`
  holds to the spec and the code's constants to (the file types and size in
  `automations/candidate-reviewer/src/file.ts`, the two file keys), to v4's but for its version,
  container and required resume field (v4's bytes held by their sha256), v4 to v3's but for its
  version and container, v3 to v2's likewise, and v2 to v1's `manifests/candidate-reviewer.v1.json`
  but for what v2 changed — its job's reading v1's. The containers of v1 to v4 keep their pinned
  images until they are retired.
- **v5's no-file stop** (item 4): `receive` in `automations/candidate-reviewer/src/steps/candidate.ts`
  stops `FAILURES.noResume` (`automations/candidate-reviewer/src/words.ts`) when the run's input
  names no file, and `FAILURES.resumeUnreadable` when a named file cannot be opened
  (`automations/candidate-reviewer/test/candidate.test.ts`).
- **v4's blocks** (items 11–13): `automations/candidate-reviewer/src/blocks.ts` — `candidateBlocks`
  (a candidate's group), `postingBlocks` (a job's four sections), `profileButton` and
  `projectButton` (a link's logo, label and https address); the SDK's `boundedBlocks` holds them as
  sent (`automations/candidate-reviewer/test/blocks.test.ts`). A result sends `blocks` and never
  `sections` or `details` beside them, which the SDK and the platform refuse.
- **The exact words** (v3's Q1): `automations/candidate-reviewer/src/quotes.ts` — `quotesOf` reads
  `extract-resume` v2's `quotes`, and `trusted` keeps a Word resume's only where its text holds them
  (the SDK's `quotesIn`), into `read-resume`'s state. v4 shows them nowhere (v4's gaps, above);
  they were never in the output (v2's output schema, unchanged) nor in what the score is sent.
- **v3's re-ask** (Q2): `define` hands every run the platform through the SDK's `reaskingOnce`, and
  `endsUnusable` (`automations/candidate-reviewer/src/prompts.ts`) ends a step whose answer missed
  its schema twice with `FAILURES.answerUnusable`, the SDK's own sentence. One to three more paid AI
  calls a miss.
- **A job** — the item run, `items.pipeline` (`job-received`, `read-job`, `save-job`):
  `automations/candidate-reviewer/src/steps/job.ts`. The reading is `extract-posting`'s answer,
  cleaned (`automations/candidate-reviewer/src/reading.ts`), the item run's output held to the
  manifest's `items.outputSchema`; its blocks are `postingBlocks` in
  `automations/candidate-reviewer/src/blocks.ts`.
- **A candidate** — `pipeline` (`receive`, `read-resume`, `check-resume`, `score`, `save`):
  `automations/candidate-reviewer/src/steps/candidate.ts`. `scored` there is what the scoring call
  reads: the resume without the fields §4 leaves out, and without any line quoting a direction the
  resume printed to its reader, which is sent apart. The years are worked out in
  `automations/candidate-reviewer/src/years.ts` (overlapping roles once, a current role to today);
  the score, its flags — "years not shown", and each direction — and the requirements a direction
  was quoted for, moved from met to missing, in `automations/candidate-reviewer/src/scoring.ts`;
  the blocks in `candidateBlocks`; the verdict, from the score alone at one constant
  (`ADVANCE_FROM_SCORE`, `verdictOf` in `automations/candidate-reviewer/src/words.ts`), on a
  candidate's run and never on a job's. A model's refusal of the file (its type, size, bytes or
  password) is "could not be read" (`readDocument` in
  `automations/candidate-reviewer/src/prompts.ts`); any other refusal ends the run in the
  platform's words.
- **Directions planted in a document**: each of the three prompts reads its document as content,
  never as instructions to it; `extract-resume` copies what tries to direct its reader into
  `directions`, which the code keeps out of what the score judges and flags
  (`automations/candidate-reviewer/test/candidate.test.ts` plants one).
- **Word files** (`automations/candidate-reviewer/src/docx.ts`): Node's `zlib` alone, no
  dependency. `word/document.xml` and the page headers and footers (`word/header<n>.xml`,
  `word/footer<n>.xml`, read first) are found through the ZIP's central directory; their text
  comes from `w:t`, their lines from `w:p`, with tabs and breaks. Entries that together claim more
  than 5 MB inflated, any with a ratio over 100, an encrypted one or one not stored with deflate
  are refused before anything is inflated, and each inflation stops at the size its entry claims;
  a refused file could not be read, and nothing is spent on it.
- **The file's own links** ([§4](#4-ai-steps); build 28's
  F8): `readResumeFile` in `automations/candidate-reviewer/src/file.ts`, for a candidate's file
  only, reads them — a PDF's with `pdfLinks` (`automations/candidate-reviewer/src/pdf.ts`, held to
  its `PDF_LIMITS`), a Word file's with `docxLinks` (`automations/candidate-reviewer/src/docx.ts`,
  through the same directory and `DOCX_LIMITS` as its text). `fileLinks` and `withFileLinks` in
  `automations/candidate-reviewer/src/reading.ts` keep and add them as §4 says, a link only the
  file gave named by `linkLabel` (`automations/candidate-reviewer/src/words.ts`) in the output; v4's
  buttons name every link by `profileButton` instead.
- **Models and retries**: Invoice Processing's two models ("Pick a model"), `MODELS` in
  `automations/candidate-reviewer/src/prompts.ts`; no step declares a retry (§6).

The platform side needs no pull request of its own: the merge here is the deploy
([Build a flow](../../README.md#build-a-flow)), after the platform's build 28 contract
([contract/README.md](../../contract/README.md)).
