# Invoice Processing (`invoice-processing`): how it is built

This flow was built before `/create-flow`'s specs, so this file is its build's record: moved here
from the repository README in Round 21, so a change to the flow's code, prompts or manifests asks
for this file in the same change (`docs/docs-map.json`, its "automations" and "manifests" rules). It
is one of the two live flows on `defineAutomation`, exempt from the new flows' standards until its
after-pilot version, v8 ([the repository README](../../README.md#build-a-flow)).

`invoice-processing` — shown to people as **Invoice Processing** since v2, as **Bills &
Receipts** in v1 — reads every bill, invoice, receipt, credit note, statement and other
financial document in a PDF or photo, then saves each one's details for the team, or records it
in QuickBooks Online and compares a statement with it (the platform's BUILD-PLAN 25.4.1,
25.4.13–25.4.30, 25.4.54; the owner's design of 2026-10-10, plan of 2026-10-11, build-19 feedback
of 2026-10-14, Build 21 corrections of 2026-10-15 and build-21 feedback of 2026-10-17).

**v7, the version this code serves** (Round 18, the platform's BUILD-PLAN 27.3.2; the owner,
2026-10-21: "invoice is invoice processing specific"). v7 is v6 whose manifest names its documents —
`display.documentWords`, "Invoice" and "Invoices" — so the website, the app and the run package head
each document "Invoice 1 of 3" from the flow's own words, and any other flow "Document 1 of 3"; its
code is v6's. `automations/invoice-processing/test/manifest.test.ts` holds that v7 is v6 but for its
version, its own container and those words; the image serves v7 alone (its Dockerfile copies only
`manifests/invoice-processing.v7.json`); v1 to v6 stay registered and immutable, each held to its
sha256.

**v6** (Build 24; the owner's build 23 feedback of 2026-10-20, F15 and
F16). v6's results also say, for each document, the uploaded file it came from (`source.file` — a run
has one upload; its pages are not told, because the read does not report them) and, for a recorded
one, the QuickBooks company it went to (`recordedIn.accountName`, from the state its write saved):
what the run page's Format and the run package's cover read (the platform's ADR-0045). Its manifest
is v5's but for its version and its own container — `automations/invoice-processing/test/manifest.test.ts`
holds that. The SDK's `boundedDocuments` carries both fields and leaves out each value the published
schema refuses — a `source.file` not in the platform's artifact-id shape (`ARTIFACT_ID_PATTERN`: a
UUID whose version digit is 1–8 and variant digit 8, 9, a or b), pages that are not whole numbers
from 1, strictly ascending, at most 500 of them, an `accountName` past 200 characters — and keeps
the document itself (`packages/automation-sdk/src/documents.ts`).

**v5** (Build 23; the owner's build 22 feedback of 2026-10-18) — served until v6's release. v5 is
v4 with step 5 named **"Run completed"** ("Done when the run succeeds.") instead of "Email sent": the
clients check it only when the run succeeds, and a held run's approval email never checks it. Nothing
else moved — `automations/invoice-processing/test/manifest.test.ts` holds v5 to v4 less the version,
the container's origin and service account, and step 5's words. The image serves v5 alone
(`SERVED_VERSIONS`; its Dockerfile copies only `manifests/invoice-processing.v5.json`); v1 to v4 stay
registered and immutable, held to their sha256 by the same test.

**v4** (Build 22; the session's spec of 2026-10-17, §3, V1) — served until v5's release. Its
image served v4 alone; v1, v2 and v3 stay registered and immutable,
`automations/invoice-processing/test/manifest.test.ts` holding each to its sha256. v4 is v3's automation, unchanged — the same 22
steps, prompts, checks, holds, QuickBooks writes, result and `outputSchema`, and the same model
calls per file: `automations/invoice-processing/test/v4.test.ts` runs one file on v4's manifest and on v3's and finds the same
steps reported, the same calls and the same result — shown in the five steps the owner asked for
on build 21 (2026-10-17: "1. Upooad Invoice / 2. Connect integration … / 3. Then something about
AI Processing / 4. Quickbooks updated / 5. Email sent"): **Upload invoice** (`receive`) ·
**Connect integration** (no step of the run: the flow's `vendor` choice, titled "Integration") ·
**AI processing** (`extract`, `check-documents`, `verify-read`) · **QuickBooks updated** when the
flow chose QuickBooks, **Details saved** with None (the other 18 steps; the group's
`titleByConnection`) · **Email sent** (`platform: "email"`, the platform's step). Step 3's and step
4's words are the session's suggestions D2 and D3, which the owner approved; the mapping, the
vendor's title and its step are the session's choices (its S18, S19). The approval limit is in no
step (Set up only). No email setting, and the run sends no mail: the platform mails each run's
results to the workspace's owners and admins, the person who started it and any address an owner
or admin adds on step 5's screen (D1, the session's suggestion the owner approved, replacing AM3).
Every v3 setting key is v4's, so the platform's move of each flow to v4 keeps it. The platform's
Build 22 merged as `32b33ae` (its #215; `contract/README.md`); until a promotion carries it, v4
cannot be registered. What follows describes v3, v2 and v1; where they differ, this paragraph
wins.

**v3** (Build 21; the session's spec B1–B6 as the owner's AM1–AM8 change it). Its image served v3
alone; v1 and v2 stay registered and immutable, and v3 since the platform's thirty-second pin (its
#214). A file holds
any number of documents: `extract` reads them all with `automations/invoice-processing/prompts/extract-documents.v1.json`, in
parts — at most 5 documents and 80 lines a part, fewer when an answer is cut at the platform's
8,000-token cap — each its own entry with its own seller and details (`automations/invoice-processing/src/run/extract.ts`,
`automations/invoice-processing/test/documents-parts.test.ts`). Nothing is left out silently: a part that says the file is done
while it counts more documents than were read is followed by one from the next document, and a
reading still short of that count has its last document wait, "the file may hold more
documents"; a reading stopped inside a document marks its lines — a statement's rows too —
incomplete (`automations/invoice-processing/test/documents-counted.test.ts`). Each QuickBooks lookup and write runs once per document,
under its document's part of the step's key (`<key>.d1`, the SDK's `part`;
`automations/invoice-processing/src/run/fan-out.ts`); the three company reads run once for all. One document never fails the
others: one the checks cannot use is read again (`verify-documents.v1`, 20 a call), and one
still unclear — or a page clearly not a financial document — waits for one approval that names
each ("Document 2: the total can't be read.") while the rest are recorded or saved; a quote, a
purchase order, a bank statement or any other financial document QuickBooks keeps no record of
is saved with all its data (AM8; `automations/invoice-processing/test/documents-hold.test.ts`).
Two documents in one file with the same seller, date and total make the later one wait, "same
as document 1" (B1). That doubt alone never keeps a document out: two bills with their own
numbers, a bill and its credit note, or a receipt and its refund are each recorded. A copy is kept
out only when the ONE duplicate rule (`automations/invoice-processing/src/decide/duplicate-rule.ts`)
matches its twin's record: a twin recorded in the first run is found by confirm-no-duplicates'
lookup — "Saved. Not recorded in QuickBooks: may already be in QuickBooks" — and a twin written
after the approval, which that check runs too early to see, by the write itself — "Saved. Not
recorded in QuickBooks: same as document 1" (Gate 25's R5d, PR #47's review;
`automations/invoice-processing/src/run/writes.ts`, `automations/invoice-processing/test/copies.test.ts`). A receipt's or a card
refund's seller QuickBooks has no vendor for is added as one only when every check of its name
is clear (B3), and never keeps its expense out: refused, or unanswered once the step's repeats
are spent, the expense is recorded naming no vendor, the seller in its memo. The result carries
every document whole (`RunDocument`, `automations/invoice-processing/src/run/documents.ts`): its type (`invoice` among them), seller
and place, `number`, `numberLabel` and `references`, date and time, each line's words, quantity,
unit price and amount, the totals as decimal strings, how it was paid, `recordedIn` and the
lines a person reads beside it — no limit but the callback body's 256 KiB
(`RESULT_BODY_LIMIT_BYTES`; AM1, AM7): past it, the SDK's `boundedResult` leaves out a success's
`output`, and sends a held run's documents without their lines (`lineItems` empty,
`lineItemsComplete` false), so the run page and the waiting email still show each one's seller,
number, totals and status, leaving the documents out only when even that does not fit, and then,
still past it, its `blocks` whole (never cut to fit), documents or none. It never
leaves out the held state, which carries every read for the continuation's result, so the reads
themselves are the bound: measured with lines whose descriptions run to about 60 characters, a
file of 2,000 lines is sent, and one of 2,100 is refused, held or not, and the run fails. A NUL
or half a surrogate pair, which the platform cannot store, never reaches it
(`boundedDocuments`). The run sends no mail and has no email setting: the platform mails each
run's results to the person who started it, or the owner and admins (AM3).
Four step groups — Received, Read, Checked, Done — over 22 steps. Each prompt has at most 16
fields typed with a union, Anthropic's limit for structured outputs: a text not printed is `""`,
no next part `0`. A PDF may have any number of pages (the page cap dropped, AM1 and AM7; an
image's 8,000 px kept, the size the models take). v2's recordings were made for v2's prompts and
are removed with them; v3's are still to be made (`automations/invoice-processing/scripts/recording-request.ts`). The
platform's Build 21 contract merged as `69b8d97` (`contract/README.md`). What follows describes
v2 and v1, and what v3 keeps of them; where they differ, this paragraph wins, and v4's above it.

**v2.** Its image served v2 alone; v1's manifest stays, registered and immutable, until it is
retired. v2's manifest is category Accounting; QuickBooks is an optional connection,
chosen in its one `connection` setup field, `vendor` — "None" by default; two settings, the
approval limit and "Also email", neither required, and no setting can fail a run
(`automations/invoice-processing/test/settings.test.ts`); no "paid personally" input (decision 4) — `find-payer`, the owners
setting and the journal entries are gone; and five visible step groups — Received, Read,
Checked, Done, Emailed — over 24 steps, `save-details` new. With the vendor "None" a run is
receive → extract → check-document → (verify-read) → save-details → notify, and calls
QuickBooks for nothing (`automations/invoice-processing/test/none-path.test.ts`). `find-accounts` reads the company's chart
with one query (the kit's `chartQuery()`), and `decide` picks from it (`automations/invoice-processing/src/decide/picks.ts`,
`automations/invoice-processing/test/picks.test.ts`): the category by the spend type's list of names, else its detail type,
else Uncategorized Expense; what a receipt or a refund was paid from — the card its printed
digits name, the only card, the only bank — else it waits for approval showing the first by
name. The second AI read runs only when the first shows a problem, or, with QuickBooks, over the
limit (decision 3; `automations/invoice-processing/test/second-read.test.ts`). A document QuickBooks cannot take — one of its
recording rules, or QuickBooks failing mid-run, a write it may have made included (decision 6,
through the SDK's `recover`) — never fails the run: its details are saved and the result says
"Saved. Not recorded in QuickBooks: …", or "Saved. QuickBooks didn't confirm. Check QuickBooks
before you run it again." Every word a person reads is the spec's (its §3.E and §3.F): timeline
lines of 80 characters at most, a one-sentence result, the run's `details` as label and value
lines, the same lines mailed, and no reason code anywhere (`automations/invoice-processing/test/words.test.ts`). The
manifest's additions and the result's `details` are the platform's #210 (ADR-0037), copied
into `contract/schemas/` from its branch before it merges (`contract/README.md`): until it
merges and is promoted, v2 cannot be registered. What follows describes v1, and what v2 keeps
of it; where they differ, this paragraph wins, and v3's above it.

**v1.** It was built in groups, each appending its steps to
`manifests/invoice-processing.v1.json`; v1 holds all 24 and was registered on 2026-10-12 (the
platform's #205, read back live by its #206), so that file is now immutable and a change to it
is a v2 (below). The first five steps spend nothing. `receive` holds the platform's
measurements of the upload — its real kind, its size, a PDF's pages, an image's pixels, taken
once when the upload was sealed — to the
owner's limits (a PDF, JPEG or PNG, measured as the type it declares; 3,500,000 bytes; 10
pages; 8,000 px a side), fails closed when one is missing, and never downloads the file;
`read-company` proves QuickBooks is connected and the company is in the US, and keeps
whether it runs QuickBooks Payroll; `read-preferences` keeps the home currency, the
multicurrency flag, the books' closing date and whether a vendor credit may carry its own
number; `find-accounts` resolves every account the flow's settings name — the default
category, Paid from, Owed to team members, Owner's investment account, each owner's own
account and one category per spend type — in one `FullyQualifiedName IN (…)` query, each
name beside the one QuickBooks gives an account it made inactive, "<name> (deleted)", so an
inactive account is said to be inactive and not missing; Intuit's IN compares an account's
names with case (sandbox S1), so a setting must match QuickBooks exactly, capitals included,
as its help in the manifest and its "No QuickBooks account matches" sentence say (the owner's
"Exact capitals, said clearly", 2026-10-12); each held to the kinds its role accepts and,
with multicurrency on, to USD, and before that query
fails the run on a "Company card's last four digits" filled in but not exactly four digits,
which would otherwise turn the card check off unseen; `find-payer`, when a
person switched on "I paid for this with my own money", finds who paid among the flow's
owners and partners, or as an employee in QuickBooks — an inactive one, found by the
"(deleted)" name QuickBooks gives it, failing as inactive — before anything is read. `extract`,
the first of its two model calls, sends ~~`automations/invoice-processing/prompts/extract-document.v1.json`~~ — 17 rules and a
27-field answer schema, 16 of its fields nullable — with a fixed task, `MODELS`
(`anthropic/claude-haiku-4.5`, then `google/gemini-3.1-flash-lite`) and the run's file by
its id; it starts no call with less than 260 seconds to the deadline, repeats one only when
nothing reached the platform, and passes the answer on whole in `state.extraction`, beside
`state.modelServed`, for the next step to check — its timeline line names the model and
counts, never a value. `check-document` (code only) cleans that answer once — text, whole
cents, real dates from 2000 on, ISO 4217 codes, a receipt's tip and card digits, a credit's
signs, a statement's rows — routes it (a bill, an expense from "Paid from", a card refund, a
vendor credit, a statement compared only, or what an employee, an owner or a contractor paid
personally), holds it to the 28 fail rules in the plan's order, each a fixed sentence, runs
the arithmetic in whole cents within 1¢, and keeps `state.document` with what decide is to
hold on; the raw answer leaves the state there. `verify-read`, the second model call, sends
~~`automations/invoice-processing/prompts/verify-document.v1.json`~~ — read 1's own definitions for the type and the 13 fields
that go into QuickBooks, 14 fields of which 8 nullable — blind to the first read, with
`excludeModelAuthors` set to the maker of the model that served it; without a maker to leave
out, or answered `no_model_left`, it is not made, never made without the exclusion. It
compares the fields the route writes, exact after the same cleaning and the seller roughly,
records the second total only when it alone adds up (and runs the arithmetic again), and
keeps `state.verification` for decide: a difference holds, a statement's disputed type fails
(F7), a second read not made holds; out of time and the platform's faults fail. Nine lookups
follow (steps 9–17), each ONE `query.run` per document type, as the plan's §5 table runs it,
or skipped (`automations/invoice-processing/src/lookups/queries.ts` builds every text, and fixed-text tests hold each):
`find-vendor` and `find-vendor-company` find the seller — or the contractor who paid — by the
exact name and the "<name> (deleted)" QuickBooks gives a vendor it made inactive (sandbox
G4–5), so an inactive vendor is never taken for a new one, then by company name, which
QuickBooks leaves as it was, active or not, each row re-checked in code (an inactive
vendor fails "reactivate it" and two fail — but a company receipt's or a card refund's seller,
looked up only to link an existing vendor (D20), is then not linked: no payee, its line saying
why — and a person nobody has is V1); for a bill's new vendor, `find-similar-vendors` lists up
to three vendors with its distinctive word for the approver, inactive ones shown by the name
they had and marked once, and
`find-customer-name` and `find-employee-name` check the name is free (employees a connection
cannot read go on as unreadable — sandbox S7); then `find-duplicate-number`,
`find-duplicate-amount`, `find-related` and `find-other-record` gather the records decide
weighs — a number QuickBooks could not hold (none, or over 21 characters: the document's own,
a credit's original invoice number, every one a statement lists) says "Not checked" and is
never sent, a full answer is a possible duplicate (D6) whose line always keeps "maybe more",
a statement's listed invoice numbers — each once, whatever its case, one past 21 characters
counted as not in QuickBooks — and open bills are this vendor's, and a statement's lookup
QuickBooks refuses ends "Compare the statement in QuickBooks". The bank-feed check (D21) searches
expenses by amount in its window: `EXPENSE_SEARCH` is `'amount'` (`automations/invoice-processing/src/lookups/expense-search.ts`),
because sandbox S4 answered on 2026-10-12 that Intuit filters `TotalAmt =` within a date range;
the plan's fallback, `'window'` — the window alone, newest first, 50 at most, a bill's D32 check
dropped — stays in the code, run only by the suites. `decide` (`src/decide/`, step 18) makes
one result: a fixed sentence, one hold with every reason (the SDK's held outcome, an approval
resuming after it), a statement
compared, or the record planned; its whole input is `automations/invoice-processing/src/decide/contract.ts`, and the
lookups and decide share one table of which lookups run (`lookupUses`,
`automations/invoice-processing/src/decide/lookup-uses.ts`). What decide saves — the record planned, the re-check an approval
repeats, the company it checked — is the ONLY input of the six steps after it (24 of the 24 the
platform allows): an approval resumes at `confirm-company`, which compares the company's names,
country and file creation time with QuickBooks' again; `confirm-vendor` looks a new vendor up
again by the name it would get, and links one added while the run waited; `create-vendor` adds it
as the approver saw it named, a lost answer repeated as create-record's is (below); `confirm-no-duplicate` repeats the path's own duplicate lookup —
the very query, one row more and the newest created first (`ORDERBY MetaData.CreateTime DESC`,
which Intuit applies before the bound: sandbox G4–5), so a copy made while the run waited is
never past it, by the document's number only when the record will carry it, else by
its total and date — and fails on a matching record added while the run waited ("A matching
record was added in QuickBooks while this waited for approval, possibly from your bank feed."),
by the one rule decide holds on (`automations/invoice-processing/src/decide/duplicate-rule.ts`): one the approver never saw,
unless decide's lookup was full and QuickBooks created it before that answer, which the approved
"too many to check" covered; a first run skips all four. `create-record` then makes the one
record — a bill, an expense, a refund to the card, a vendor credit or a journal entry, through
the platform's `bill.create`, `purchase.create`,
`vendorCredit.create` or `journalEntry.create`, each with its `requestid` — from the saved plan
alone, never the settings as they are by then, its memo naming the run that wrote it (after an
approval the continuation); a lost answer, or a 502/503/504 naming no reason, repeated by the
step's retry under the same key, so the same `requestid`, which QuickBooks answers with the
first record and never a second (sandbox S6) — and, once the attempts are spent, for
QuickBooks' own 429 or 5xx or Fault 600, or for any refusal of a repeat (the attempt that went
unanswered may have made the record), "did not confirm" — and each Intuit code the plan maps
(6140, 6240, 610, 2500, 6190, 6200, 6210, 2050, 2290, 2300, 6430) has its own sentence. Its line,
which is also the run's summary, says what was recorded and the next step — "When this charge
arrives in your bank feed, choose Match, not Add" for a receipt or a refund, how an employee, a
contractor or an owner is repaid. `notify` mails a plain-text summary, built from QuickBooks'
answer — the document's number on its line, "in the memo" when the record was not sent it, and
the number QuickBooks gave an expense or a credit itself on its own — to the optional "Also email"
address — a statement's counts and what QuickBooks shows open — and is skipped when it is empty;
a mail that fails never fails the run. The run's result (`automations/invoice-processing/src/output.ts`, described by the
manifest's `outputSchema`, which the tests hold every output
to with Ajv) is the record made — its type and QuickBooks Id, payment type, payee, payer, Paid
from account, the next step, why it was held — or a statement's comparison with the full list of
the invoice numbers it lists that QuickBooks lacks.
Every failure ends the run with a fixed sentence, a run that ends on a thrown error
included — never the error's message; once the record exists, a run that cannot finish (the
platform refusing a step's report, say) names it and says to check QuickBooks before running
it again, never "run it again in a few minutes". The measurements — `measuredKind`, `pageCount`,
`widthPixels`, `heightPixels` — are copied into the SDK's `ArtifactReference` from the
platform's pull request before it merged (its BUILD-PLAN 25.2.28, merged unchanged as its
`main` `7086e5e`), and `measurementsOf` in `automations/invoice-processing/src/file.ts` is the one place that reads them;
the manifest declares the page and pixel limits, without which the platform measures
nothing.

Its tests need no model key. `test/samples/` holds 25 made-up documents — bills (typed,
scanned, photographed, a portal screenshot, hand-printed, 300 lines, a utility bill with an
earlier balance, one whose largest print is its account number), receipts (a till roll, a
store receipt and a fuel slip photographed, restaurant receipts with a tip and total
written in and with a tip under a printed total, a card slip with only a tip written in, a
hand-written cash receipt, a 60-line thermal roll at 2,576 px, cash back, an invoice
stamped PAID), a credit memo, a refund to a card, a supplier statement, a card statement,
two invoices in one file, a page missing, and instructions to the model printed on one —
each drawn by `test/sample-maker/` beside its `expected.json`, with a marker printed in a
line's text or a notes box, never in the seller's name or the document number, that no
answer, timeline line or reason may carry; `npm run samples` (in the automation) makes them
again and rewrites a file only when what it draws changes. Each sample is recorded twice, by
two agents blind to each other: read 1 — an agent acting as the model, given exactly what
`npm run recording-request` prints for a sample — in
`test/recordings/extract-document.v1/<sample>.json`, and read 2, given what
`npm run recording-request -- --read 2` prints, in `test/recordings/verify-document.v1/`;
the loader refuses one made for another prompt or version, or other prompt or sample bytes.
All 50 are recorded — read 1 by agents on `claude-opus-5-5`, read 2 on `claude-sonnet-5-5`,
each given only its read's request and the document under a neutral file name — and the tests
over them run each pair through steps 1–8 with the model answering as recorded, check-document,
read 2's comparison and decide (the vendor matched, nothing found): the sample's marker reaches
no line, sentence, reason or saved data. `automations/invoice-processing/test/planted-marker.test.ts` plants each marker in
every field the code reads but never passes on — read 1's currency, card digits, dates and
listed references (not a statement's, which are carried), read 2's currency, card digits and
dates — on every path, held and straight through — and `automations/invoice-processing/test/writes-marker.test.ts` takes each
sample's marker through every step on the simulator, approved when it held: no QuickBooks
request, mail, line or result carries it.
