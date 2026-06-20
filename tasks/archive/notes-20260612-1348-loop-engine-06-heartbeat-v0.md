> **Archived**: 2026-06-12 13:48
> **Related Plan**: plans/archive/plan-20260612-1312-loop-engine-06-heartbeat-v0.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260612-1348

# Implementation Notes: loop-engine-06-heartbeat-v0

> **Status**: Complete
> **Plan**: plans/plan-20260612-1312-loop-engine-06-heartbeat-v0.md
> **Contract**: tasks/contracts/20260612-1312-loop-engine-06-heartbeat-v0.contract.md
> **Review**: tasks/reviews/20260612-1312-loop-engine-06-heartbeat-v0.review.md
> **Last Updated**: 2026-06-12 13:32
> **Lifecycle**: notes

## Design Decisions

- `heartbeat-triage.sh` is an on-demand repo-local runner that is safe for cron/loop wrappers. It records findings and exits 0 for workflow findings so schedulers keep running.
- The slice does not install launchd/crontab entries. Scheduler installation stays host-local and manual because unattended persistence is outside the repo contract.
- The inbox is runtime state under `.ai/harness/triage/inbox.md`; `.ai/harness/triage/.gitkeep` is tracked only to reserve the runtime directory.
- The runner records exactly the row 6 signals: `check-task-workflow.sh --strict`, `sprint-backlog.sh next` when a marker exists with a read-only sprint-file fallback, and pending files under `docs/architecture/requests/`.
- Contract verification used a complete worktree-local `REPO_HARNESS_BRAIN_ROOT` under `.ai/harness/runs/row6-brain-vault` because the default iCloud brain vault is shared by concurrent worktrees and may be rewritten to another branch during long test commands.

## Deviations From Plan Or Spec

- Added `docs/reference-configs/heartbeat-triage.md` plus asset parity so scheduler examples ship with the helper.
- The three scheduled proof runs intentionally produced workflow-check findings because BrainSync drift was present; that was treated as useful triage output, then fixed with `sync-brain-docs.sh`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Auto-install cron/launchd | Rejected | Persistent unattended execution should remain a host-local human choice. |
| Heartbeat exits nonzero on workflow failure | Rejected | Findings should be durable inbox entries; failing the scheduler would hide later findings. |
| Track `inbox.md` | Rejected | Inbox is runtime triage state, like checks and run snapshots. |
| Append-only inbox | Chosen | Preserves consecutive run evidence and avoids losing prior findings. |

## Open Questions

- Whether a later slice should add adoption metrics by reading accepted follow-up plans or manually tagged inbox entries.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scheduled proof runs: `.ai/harness/runs/row6-scheduled-1-heartbeat-triage.json`, `.ai/harness/runs/row6-scheduled-2-heartbeat-triage.json`, `.ai/harness/runs/row6-scheduled-3-heartbeat-triage.json`
- Inbox: `.ai/harness/triage/inbox.md`
- Focused tests: `bun test tests/heartbeat-triage.test.ts tests/bootstrap-files.test.ts tests/migration-script.test.ts tests/scaffold-parity.test.ts tests/workflow-contract.test.ts tests/create-project-dirs.runtime.test.ts`
- Adoption review scheduled: 2026-06-26. Review whether heartbeat entries produced a human-accepted triage item; if not, do not install a scheduler.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `tasks/research.md` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
