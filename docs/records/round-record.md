# Round record: current

The rounds open in this repository, one section per round. Moved verbatim from the "Round record" table in CLAUDE.md on 2026-10-18 (one `## Round <n>` per row; only the table syntax changed); its file references were then written out in full so each resolves (repository paths, `snoopy-backend/` before the platform's, removed files struck), and no other word changed. When a round closes, its section moves unchanged to [round-record.archive.md](round-record.archive.md). Grep by heading rather than reading the file whole.

## Round 18

**OPEN 2026-10-21 in the platform (its BUILD-PLAN Phase 27, MASTER-PLAN §0.1): the flow standard.** This repository's part: 27.3.1, the `new-flow` skill and its spec template ([.claude/skills/new-flow/](../../.claude/skills/new-flow/SKILL.md)), on `round-18/new-flow`; then 27.3.2, Invoice Processing v7 — v6 with `display.documentWords` "Invoice" and "Invoices" — on `round-18/v7`, `contract/schemas/automation-manifest.json` refreshed from the platform's 27.2.1 and pinned at its merge, `d371251` (#231). Merged as #48 (`9fbd727`) and #49 (`dcc8600`); v7 live at the platform's THIRTY-EIGHTH (2026-10-22).

**2026-10-22, the platform's 27.8.6 (its BUILD-PLAN 25.4.11's half here), on `round-18/group-2` (#50):** `invoice-check` and `invoice-intake` leave this repository — their code under `automations/`, their seven manifests, the CI image build and Publish entries, and Dependabot's two Docker entries — after the platform's local flows moved to a fixture of their own (`snoopy-backend` #233). The root lock drops both workspaces. The SDK's schema tests keep `invoice-check` v1's manifest, byte for byte, as their reference (`packages/automation-sdk/test/fixtures/reference-manifest.json`); the isolation test names a placeholder automation. Their images stay in GHCR, unpublished from here; the platform's catalog keeps their rows, withdrawn.

## Round 17

**CLOSED 2026-10-21 in the platform** (its MASTER-PLAN §0.1, Gate 25 eight of eight). Moved unchanged to [round-record.archive.md](round-record.archive.md#round-17) on 2026-10-21.
