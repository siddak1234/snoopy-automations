# /create-flow stage 1b: Research

The steps of [SKILL.md](SKILL.md)'s stage 1b, between the decisions and the spec. The session runs
them alone; the owner approves the brief at stage 2, with the screens and the words. The owner's
words (2026-10-27): "understanding the use case end to end. how it works, the expert ideology and
deep expertise in that specific problem. not just some random generic. this does not mean
complicate flow. something simple, intuitive but depth in the research and understanding"; "no
assumptions".

## When

After the platform check — a platform stop spends nothing on research — and after the decisions:
clarify first, research second (O2: "Do NOT conduct any research yourself, just gather information
that will be given to a researcher"). The five-decision cap stays: what research leaves open goes
to the spec's section 11 with its default, never a new round of questions.

## The run

The Workflow tool, with `scriptPath` set to the clone's `.claude/workflows/flow-research.js` and
`args` set to `{ runDir, automations, name, idea, answers, platform }` — no backend clone: the
adoption lens reads the menu, `contract/schemas/platform-menu.json` (a `backend` clone, when given,
is read-only and its files a source too). Inside: the
owner's words quoted, never researched; four lenses — practice and expert judgement; rules,
standards and data, the model vendors' rules on our own AI calls included; adoption; the
streamlining of the process — then the integrations stage; at most three agents at once
(`MAX_AGENTS`); one synthesis from the gated findings only; one skeptic that re-opens every cited
page and judges every line, golden case and cited default against the quotes it cites; a code
gate after each (A2: "programmatic checks").

**The integrations** (the owner's words, 2026-11-01: "integrations and connections to third party
services is a crucial part in our create flow"). The adoption lens ranks at most five integrations
the business line uses, by evidence of adoption (market share, surveys, regulator or certification
data, the vendor's own customer counts), each with its source and its menu status (a provider id,
or "to add"); one past five is a gap. After the lenses, one researcher per integration, three at
once, at most 15 tool calls each (as adoption; A1's 10–15), labels each finding with its part:
**docs** (the official API, sign-in, events and webhooks, read and write operations, sandbox, rate
limits, data formats; any MCP server, official or in a known MCP registry; the official SDKs);
**in practice** (the vendor's own guides and case studies first, then developer forums, the
official SDK's issues and community posts — T4, rendered "community report"); **cost** (the
vendor's pricing page, or "not published" as a gap); **constraints and concerns** (access programs,
contracts such as a business associate agreement, regions, deprecations, lock-in, failure modes).
The code gate keeps a T4 finding only when its part is "in practice", and a line keeps a T4 cite
only in the practice column. The synthesis writes one row per integration and "First to build: X,
because …" on confirmed ids only, else "a person decides"; research.md renders them as its
Integrations table. The script numbers each finding `<lens>-<n>`, never
the model; a finding is confirmed only when every verdict the skeptic gives it says confirmed,
and a line stays only when every id it cites is confirmed and every verdict for the line says
supported (any other verdict beside them is a gap); a throw before the skeptic's gate finishes writes no line of the brief, each one a gap.
From the ICD-10 pilot (Round 21): the practice lens researches every list a person picks from (a
setup choice, a run choice) as the full official list, with its source and its count (F1: "These
are not all specialties that use icd10 codes. Your research was not sufficient." — six specialties
were chosen by the session); a lens gets at most four questions — the frame is told so, and the
script keeps four after adding its own, first, each one past them a gap — so it fits its call
budget; a quote is one exact sentence copied character for character, and a very long page is
skipped for a small specific one (pass 1's vendors lens: every finding dropped as a paraphrase or
out of calls; passes 2–4 needed).
Its `researcher` agent is the kit's ([.claude/agents/researcher.md](../../agents/researcher.md),
byte for byte `snoopy-backend/.claude/agents/researcher.md`, installed by `claude-install`):
without it every lens fails.

## The steps

1. Read the Workflow **result**, the script's top-level return value — `research`, `djb2`,
   `length`, `stopped`, `gaps`, `notResearched`. The Workflow tool hands the session that value;
   `log()` lines do not reach the session.
2. Run `node .claude/skills/create-flow/research-render.mjs <runDir>/research.json <djb2> <length>`.
   Exit 0: the file is the one the script computed, and research.md is written beside it. Exit 1 (a
   mismatch, or no file): re-run the workflow with `resumeFromRunId` and `args.writeAttempt = 2`,
   so only the write runs again. A second mismatch: tell the owner research.json could not be
   written, with the result's gaps; no spec is written.
3. A `stopped` result: show the owner the stop and the gaps; no spec is written from it.
4. Show the owner, at stage 2 beside the screens and the words, in 10 lines or fewer, how the work
   is done today, what an expert checks, the Integrations rows and the first to build, what the first
   version automates and leaves to a person, and what was not found; then the gaps and every
   not-researched default. A default no confirmed source carries, whatever its kind, is "a person
   decides" unless the owner keeps its proposal. The owner approves the three in one approval
   ([SKILL.md](SKILL.md), stage 2); record the owner's yes or corrections verbatim, with the time.
   Nothing is registered from a brief the owner has not approved.

If an Integrations row the flow uses says "to add", tell the owner the check's answer is now "a
new vendor" (stage 1): a provider file, or a platform round when no file can describe it. The approved brief is copied beside the spec as
`automations/<name>/research.md`: sources and invented examples only, never a customer's data
(this repository is public). Each pilot failure joins the research evals,
[evals/research.md](evals/research.md), at stage 8.

## Sources

The tags this stage, `.claude/workflows/flow-research.js`, [evals/research.md](evals/research.md)
and the templates cite (every page fetched 2026-10-27, every quote found on it):

| Tag                 | Source                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1                  | Anthropic, How we built our multi-agent research system, https://www.anthropic.com/engineering/multi-agent-research-system                            |
| A2                  | Anthropic, Building effective AI agents, https://www.anthropic.com/engineering/building-effective-agents                                              |
| A3                  | Anthropic, Reduce hallucinations, https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations                   |
| A5                  | Anthropic, Demystifying evals for AI agents, https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents                                   |
| O1                  | OpenAI, A practical guide to building agents, https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf           |
| O2                  | OpenAI API, Deep research, https://developers.openai.com/api/docs/guides/deep-research                                                                |
| O3                  | OpenAI API, Evaluation best practices, https://developers.openai.com/api/docs/guides/evaluation-best-practices                                        |
| Mitigate jailbreaks | Anthropic, Mitigate jailbreaks and prompt injections, https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks |
| WF                  | the Workflow tool's own reference (the `workflow-authoring` skill), no URL                                                                            |
