---
name: new-flow
description: Use when the owner brings an idea for a new flow — a document, a diagram, notes or a description. Writes it down as one spec in a fixed form, limited to what the platform accepts; the owner approves the spec, words included, before any code; then /new-automation-version builds it, a reviewer checks the build against the spec, and the platform's half and both clients' screens follow.
---

# New flow, from an idea

A flow is one automation with one job: its own AI steps, JSON schemas and integrations, reusing the
SDK and the kit (`packages/`). This repository holds the flows; the platform holds what they are
registered with, the secrets and the shared integrations; the website and the app draw what the
platform sends, with no code for one flow (`snoopy-backend/docs/platform/AUTOM8X-MASTER-PLAN.md` §3.4,
read only). So a new flow is a change here and a change in `snoopy-backend`, and the app needs none.

## Inputs

- The owner's idea, in whatever form it comes. Read every file given, images and PDFs included.
  A customer's file is read, never committed: this repository is public.

## Steps

1. **Read before writing.** [templates/spec.md](templates/spec.md); the platform's rules beyond the
   schema ([contract/README.md](../../../contract/README.md#what-the-platform-refuses-beyond-the-schema));
   the integrations and the operations each offers (`snoopy-backend/providers/*.json`, read only); the
   plain-words rules (`snoopy-mobile/app/CLAUDE.md` and `snoopy/app/CLAUDE.md`, "Plain words"); the
   newest `manifests/invoice-processing.v<n>.json` as a filled example.
2. **Write the spec.** Copy the template to `automations/<name>/README.md` and fill every section
   from the idea. Write nothing the idea does not say: each gap is an open question with a proposed
   default (section 11). A value outside the platform's lists — a control, a capability, a trigger,
   a section, a department, an icon, a provider or an operation — is never written as if it existed;
   it goes in section 10, naming the repository and the change.
3. **Check every word** a person reads against the plain-words rules: the fewest questions, and
   nothing asked that a connected app already knows; few steps, numbered, titles only; no jargon and
   no explanations; "flow" and "department", never "automation", "team" or "project". Remove before
   explaining.
4. **The owner approves the spec.** Show it as the screens will read it: the name, the setup
   questions, the numbered steps, what a run gives, the failures. Build nothing until the owner
   approves; write the date and the owner's words at the spec's top. A change after approval comes
   back here.
5. **The platform first, when section 10 is not empty.** Each line is a finding for that repository
   (rule 1 of [CLAUDE.md](../../../CLAUDE.md)); it is built and live before this flow is.
6. **Build** with `/new-automation-version` ([SKILL.md](../new-automation-version/SKILL.md)), its
   first step copying the template beside the spec (`mkdir -p automations/<name> && cp -R templates/automation/. automations/<name>/`): the
   manifest from sections 1–3, 5–6 and 7's output, the prompts from section 4, the code from the steps,
   the tests from section 9.
7. **Review.** The `reviewer` agent checks the branch against the approved spec, section by section:
   every step, word, schema, integration and failure the spec names is in the manifest and the code,
   and nothing it does not name.
8. **The platform's half.** The finding `/new-automation-version` ends with
   (`snoopy-backend/scripts/add-automation.mjs`), then the backend's `pin-pr` and `release` skills;
   the owner merges each pull request and says go for the release.
9. **The screens.** Once released, the flow's pages on the website and in the app read as the spec
   does — the catalog card, the setup questions, the steps, a run's results, the email — with no
   change to either client. The app is checked on one headless simulator, and only with the
   owner's OK.

## Stop when

- The owner has not approved the spec: nothing is built.
- Section 10 is not empty: stop at step 5 and report it.
- A step would need code in `snoopy-backend`, `snoopy` or `snoopy-mobile`: that is section 10, not
  an edit.

## Output

- `automations/<name>/README.md`, the approved spec; then what `/new-automation-version` outputs.
- [README.md](../../../README.md)'s section for the flow links the spec and says what is built.
