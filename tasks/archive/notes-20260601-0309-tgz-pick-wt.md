> **Archived**: 2026-06-01 03:09
> **Related Plan**: plans/archive/plan-20260601-0139-tgz-pick-wt.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260601-0309

# Implementation Notes: tgz-pick-wt

> **Status**: Active
> **Plan**: plans/plan-20260601-0139-tgz-pick-wt.md
> **Contract**: tasks/contracts/20260601-0139-tgz-pick-wt.contract.md
> **Review**: tasks/reviews/20260601-0139-tgz-pick-wt.review.md
> **Last Updated**: 2026-06-01 03:00
> **Lifecycle**: notes

## Design Decisions

- Added the dirty merged linked worktree guard to `ship-worktrees.sh`, not to ad-hoc operator docs, because `--cleanup-merged` is the official post-merge closeout entrypoint.
- Kept `contract-worktree.sh cleanup` conservative: it still refuses dirty linked worktrees and now points scaffold-only discard back to `ship-worktrees.sh --cleanup-merged --discard-scaffold-only`.
- Defined scaffold-only discard as a narrow path allowlist: `tasks/todo.md`, captured `plans/plan-*.md`, sprint contract/review/notes files, active-plan markers, and worktree metadata JSON. Any source/doc/config path blocks discard and must be picked, applied, or committed.
- Replaced the `prepare-codex-handoff.sh` global handoff writer's primary Python path with a Node path, leaving Python as fallback, because the current verification environment kills `python3 -` and that made the required helper test non-reproducible.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Auto-pick dirty deltas into `main` | Rejected | The script cannot infer whether a dirty diff is useful product work or stale local scratch. |
| Archive dirty deltas to `_ops` tgz and cleanup | Rejected | A tgz is backup, not a merge/pick closeout, and caused the original failure mode. |
| Explicit scaffold-only discard | Accepted | It covers generated workflow noise while preserving the invariant that source deltas remain reviewable git changes. |

## Open Questions

- None.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Sprint verification: `bash scripts/verify-sprint.sh` -> passed, run snapshot `.ai/harness/runs/run-20260601T030122-44840-20260601-0139-tgz-pick-wt.json`.
- Full test suite: `bun test` -> 544 pass, 6 skip, 0 fail.
- Required checks: `check-task-sync`, `check-deploy-sql-order`, `check-task-workflow --strict`, `inspect-project-state`, and `migrate-project-template --dry-run` passed.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
