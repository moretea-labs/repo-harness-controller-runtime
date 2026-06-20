> **Archived**: 2026-06-13 04:00
> **Related Plan**: plans/archive/plan-20260613-0327-plan-completeness-gate-ux-contract.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260613-0400

# Implementation Notes: plan-completeness-gate-ux-contract

> **Status**: Active
> **Plan**: plans/plan-20260613-0327-plan-completeness-gate-ux-contract.md
> **Contract**: tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md
> **Review**: tasks/reviews/20260613-0327-plan-completeness-gate-ux-contract.review.md
> **Last Updated**: 2026-06-13 03:27
> **Lifecycle**: notes

## Design Decisions

- Kept `PlanCompletenessGate` as a Stop block because it protects the `plans/` source-of-truth boundary for transient host planning output.
- Changed only the emitted guidance: a complete planning answer now gets a concrete `scripts/capture-plan.sh` command, and an incomplete one gets the existing completeness checklist.
- Used Bash `%q` quoting for derived `prompt_slug`, `source_ref`, and `kind` values so the displayed command remains copy-safe for spaces and punctuation.
- Mirrored `.ai/hooks/stop-orchestrator.sh` to `assets/hooks/stop-orchestrator.sh` and verified byte-for-byte content parity.
- Fixed the linked-worktree hook-runtime fixture by adding a `NODE_PATH` fallback to the test harness. Hook subprocesses that execute `src/cli/index.ts` can now resolve `commander` from the main checkout's `node_modules` when the isolated contract worktree itself has no install.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Remove `PlanCompletenessGate` | Rejected | Would allow plan-like host output to end without a repo-local capture reminder. |
| Auto-run `capture-plan.sh` from Stop | Rejected | Stop does not own semantic validation of the final plan body and should not become a mutating orchestration engine. |
| Improve Stop guidance only | Accepted | Smallest change that addresses the observed friction while preserving one-shot behavior and pending-plan safety. |
| Run `bun install` in the contract worktree | Rejected | Would repair only this local worktree; the test harness would still be fragile in future linked worktrees. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Syntax: `bash -n .ai/hooks/stop-orchestrator.sh assets/hooks/stop-orchestrator.sh`
- Focused tests:
  - `bun test tests/hook-runtime.test.ts -t "stop-orchestrator: blocks once to force pending plan completeness review"`
  - `bun test tests/hook-runtime.test.ts -t "stop-orchestrator: skips recursive Stop continuations and supports Codex block JSON"`
  - `bun test tests/hook-runtime.test.ts -t "post-edit-guard: records architecture drift and syncs local context contract blocks"`
- Full hook-runtime suite: `bun test tests/hook-runtime.test.ts`
- Parity: `cmp -s .ai/hooks/stop-orchestrator.sh assets/hooks/stop-orchestrator.sh`
- Contract: `bash scripts/verify-contract.sh --contract tasks/contracts/20260613-0327-plan-completeness-gate-ux-contract.contract.md --strict`
- Workflow follow-up: after full hook-runtime verification, `bash scripts/sync-brain-docs.sh --changed docs/reference-configs/harness-overview.md` synced the registered default-brain mirror, and `bash scripts/check-task-workflow.sh --strict` now passes.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
