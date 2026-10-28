<!-- A flow's pull request: its folder, its manifest and the generated files (README.md, "Build a flow"). -->

## What a machine has checked

CI's **Review rows** (Verify, in the run's summary; `scripts/review-rows.ts`) answer §3 the menu,
§4 the capabilities, §6 the steps, §7 the blocks, §8 the failure words, §9 the tests, the paths and
the failure drill. A FAIL row fails Verify.

## What a person reviews

- [ ] **Domain**: every domain fact in the spec and the prompts rests on `research.json`, on ids
      the skeptic confirmed.
- [ ] **Privacy**: a model is sent only what the spec's privacy rows say.
- [ ] **A customer's file**: no customer data in the diff (this repository is public); every prompt
      that reads a file treats its text as content, never an instruction.
- [ ] **The words**: every word people read is the approved spec's and `words.md`'s.
- [ ] **The steps' logic**: each step does what the spec's section 6 says, and each test bites.

Spec: `automations/<id>/README.md` · Checklist: `.claude/skills/create-flow/templates/review.md`
