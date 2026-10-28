# Evals: the research stage (stage 1b)

The cases `/create-flow`'s research is graded on: each a real idea the owner brought, run through
`.claude/workflows/flow-research.js`, its research.md graded against a reference. The set grows
only from real use — each real idea the owner brings and each pilot failure (stage 8) — never with
invented ideas to reach a count (the owner's rule: flows are never invented as examples; O3: "grow
the eval set over time"). The target as real ideas arrive: A1's "about 20 queries representing
real usage patterns" and A5's "20-50 simple tasks drawn from real failures". Source tags: [research-stage.md](../research-stage.md), "Sources".

## How a run is graded

- One model call grades each run's research.md, 0.0–1.0 and pass or fail ("a single LLM call with a
  single prompt outputting scores from 0.0-1.0 and a pass-fail grade was the most consistent", A1),
  on A1's rubric: factual accuracy, citation accuracy, completeness, source quality, tool
  efficiency. It grades the brief: "grade what the agent produced, not the path it took" (A5).
- The session also reads the run's transcript: "People testing agents find edge cases that evals
  miss" (A1).
- The owner's corrections at stage 1b step 4 calibrate the grader: "Use human feedback to calibrate
  automated scoring" (O3).

## The cases

| #   | Flow                 | The idea (input)                                                                                                                                                          | Reference output                                                                                                                                                                |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `candidate-reviewer` | the owner's words (2026-10-23) and answers (2026-10-24), `automations/candidate-reviewer/README.md:31-42`                                                                 | its approved spec, `automations/candidate-reviewer/README.md`, and its prompts under `automations/candidate-reviewer/prompts/`                                                  |
| 2   | `invoice-processing` | not found in this repository (`git grep`, 2026-10-28). Until the owner's words for it are found and copied here with their date, this case has no input and is not scored | its newest manifest, `manifests/invoice-processing.v7.json`, and its prompts, `automations/invoice-processing/prompts/extract-documents.v1.json` and `verify-documents.v1.json` |

## Pilot failures

Each pilot failure of a flow built from a research brief is added here at stage 8: the idea, what
the brief got wrong or left out, and the corrected reference. None yet.
