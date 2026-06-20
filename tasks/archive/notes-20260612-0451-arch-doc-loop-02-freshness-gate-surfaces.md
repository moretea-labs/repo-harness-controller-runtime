> **Archived**: 2026-06-12 04:51
> **Related Plan**: plans/archive/plan-20260612-0410-arch-doc-loop-02-freshness-gate-surfaces.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-0451

# Implementation Notes: arch-doc-loop-02-freshness-gate-surfaces

> **Status**: Complete
> **Plan**: plans/plan-20260612-0410-arch-doc-loop-02-freshness-gate-surfaces.md
> **Contract**: tasks/contracts/20260612-0410-arch-doc-loop-02-freshness-gate-surfaces.contract.md
> **Review**: tasks/reviews/20260612-0410-arch-doc-loop-02-freshness-gate-surfaces.review.md
> **Last Updated**: 2026-06-12 04:42 +0800
> **Lifecycle**: notes

## Design Decisions

- Keep `architecture-queue.sh` as the owner of request card rendering and index integrity; add `check-architecture-sync.sh` as the finish-time, diff-aware freshness gate.
- Compute the gate input from `merge-base(target, HEAD)` plus porcelain status, then batch resolve paths through `capability-resolver.ts match --paths-from -`.
- Treat stale derived architecture index as a hard failure in all modes because it invalidates the queue truth. Treat matching pending requests as freshness failures only in `strict`.
- Keep the default policy advisory; `contract-worktree.sh finish` now calls the gate before `verify-sprint`, but only strict policy blocks unrelated missing dependency/freshness cases.
- Surface pending architecture queue state in `SessionStart` as context, not as prompt-guard authority.

## Deviations From Plan Or Spec

- Added `assets/reference-configs/harness-overview.md` to contract scope after `check-task-workflow --strict` exposed the registered repo/asset/brain mirror contract for `harness-overview`.
- Synced `docs/reference-configs/harness-overview.md` to both `assets/reference-configs/harness-overview.md` and the default brain mirror via `scripts/sync-brain-docs.sh --changed`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Gate finish on global pending queue count | Rejected | Would block unrelated slices and recreate the old stale-request pain. |
| Put all logic into `architecture-queue.sh status --gate` | Rejected | Queue owns cards; it does not know the current branch diff. |
| Add a new root check command | Accepted | Matches required-check conventions and keeps finish orchestration thin. |
| Enable strict by default | Rejected | The sprint only adds surfaces; policy rollout remains a later decision. |

## Open Questions

- None for this slice.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Focused suite: `bun test tests/architecture-sync.test.ts tests/hook-runtime.test.ts tests/helper-scripts.test.ts tests/workflow-contract.test.ts tests/bootstrap-files.test.ts tests/create-project-dirs.runtime.test.ts tests/migration-script.test.ts tests/scaffold-parity.test.ts`
- Full suite: `bun test`
- Required checks: deploy SQL, architecture sync advisory/strict, task sync, workflow strict, inspect-project-state, migration dry-run.

## Promotion Candidates

- The diff-aware gate pattern should be promoted only after slice 3 confirms downstream productized scaffold behavior.
