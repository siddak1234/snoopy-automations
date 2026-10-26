# Round record: current

The rounds open in this repository, one section per round. Moved verbatim from the "Round record" table in CLAUDE.md on 2026-10-18 (one `## Round <n>` per row; only the table syntax changed); its file references were then written out in full so each resolves (repository paths, `snoopy-backend/` before the platform's, removed files struck), and no other word changed. When a round closes, its section moves unchanged to [round-record.archive.md](round-record.archive.md). Grep by heading rather than reading the file whole.

## Round 21

**OPEN 2026-10-25 in the platform** (its BUILD-PLAN Phase 29, MASTER-PLAN §0.1): one approved pull request per flow, before Round 20. This repository's part so far: 29.0.5, `/create-flow` moved here from `snoopy-backend/.claude/skills/` on the owner's word ("the slash command is currently in the backend, but it should just be in the automations repo"); then the flows' CD (29.2.4), `/create-flow` v3 (29.3) and the pilot (29.4).

**Stage 4, `round-21/blocks-sdk`** (2026-10-26; the platform's BUILD-PLAN 29.3.1, 29.3.2 and ADR-0048's automations half, beside its #250, B2): `contract/schemas/` re-vendored at `1e01827`, #250's head (`automation-run-result.json`'s `blocks`, `automation-manifest.json`'s `display.pages`; the other six unchanged, all eight checked with `cmp`), and the blocks' and pages' refusals in [contract/README.md](../../contract/README.md); the SDK's blocks — the nine sendable types (`packages/automation-sdk/src/block-types.ts`), `BLOCK_LIMITS` and `boundedBlocks` (`packages/automation-sdk/src/blocks.ts`), `PAGE_PARTS` and `ManifestPages` (`packages/automation-sdk/src/manifest.ts`), a success's or held result's `blocks`, refused beside `sections` or `details` before sending — tested in `packages/automation-sdk/test/blocks.test.ts` and `packages/automation-sdk/test/blocks-bounds.test.ts` with the platform's fixtures `emitted-all-nine` and `oversize-run` copied in; the template sends its readout as blocks; `/create-flow` v3 (one builder, one review, one pull request here; a new vendor adds one provider file, a new block stops; the pilot held until the TestFlight build that draws blocks); [CLAUDE.md](../../CLAUDE.md) rule 5 and [README.md](../../README.md#adding-an-automation): a flow needs no backend pull request and no client change. No automation's version or manifest changed (ADR-0048 §7: today's flows drawn by the platform's defaults). Re-pinned to #250's merge commit by the session before it lands.

## Round 19

**CLOSED 2026-10-25 in the platform** (its MASTER-PLAN §0.1, Gate 28; the owner tested build 29 on the app and the website). Moved unchanged to [round-record.archive.md](round-record.archive.md#round-19) on 2026-10-25.

## Round 18

**CLOSED 2026-10-23 in the platform** (its MASTER-PLAN §0.1, Gate 27 seven of seven). Moved unchanged to [round-record.archive.md](round-record.archive.md#round-18) on 2026-10-25.

## Round 17

**CLOSED 2026-10-21 in the platform** (its MASTER-PLAN §0.1, Gate 25 eight of eight). Moved unchanged to [round-record.archive.md](round-record.archive.md#round-17) on 2026-10-21.
