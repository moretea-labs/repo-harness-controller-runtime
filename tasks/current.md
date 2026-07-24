# Current Status Snapshot

<!-- updated_at: 2026-07-24 -->
<!-- stale_after: 24h -->

> **Status**: Campaign completion-path workspace cleanup fix merged;存量分支/worktree 回收进行中
> **Updated At**: 2026-07-24
> **Source**: Campaign auto-cleanup root-cause investigation
> **Target**: 修复 accept_campaign 完成路径未触发 cleanupManagedWorkspace 的设计缺口
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- `accept_campaign` 接入 `completeCampaignWorkspace`（基于 `git branch --merged` 而非 baseRevision 保护），彻底修复完成路径 worktree/分支不自动回收的问题。
- 存量 14 个已合并 campaign 分支 + 8 个 campaign worktree 待手动回收（1 个未合并分支保留）。

## Validation Completed

- `bun tsc --noEmit`: 0 errors.
- `bun test`: 2026 passed, 1 flaky Gmail-routine timeout (pre-existing, passes standalone).
- `bash scripts/check-deploy-sql-order.sh`: OK.
- `bash scripts/check-architecture-sync.sh`: advisory, 0 blocking.
- `bash scripts/check-task-workflow.sh --strict`: pass.
- `bun scripts/inspect-project-state.ts --repo . --format text`.
- `bash scripts/migrate-project-template.sh --repo . --dry-run`.
- Historical stuck-state migration: four false completions reopened, zero remaining false completions, four `integration_blocked`, zero `cleanup_blocked`.
- Protected recovery files remain present at `/private/tmp/repo-harness-quarantine-node-modules.txt` and `/private/tmp/repo-harness-terminal-issue-files.nul`.

## Remaining Before Delivery

- Pass the task-sync gate with this updated snapshot and complete the final independent Claude review.
- Commit the final lifecycle/Worker corrections, fast-forward `main`, and push `origin/main`.
- Install the immutable release from final `main`; confirm the live release revision matches `main`.
- Run real repository-command twice, Local Job once, minimal Task lifecycle, drift-gate, cleanup, and orphan-Worker acceptance.
