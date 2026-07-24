# Current Status Snapshot

<!-- updated_at: 2026-07-24 -->
<!-- stale_after: 24h -->

> **Status**: Campaign 性能优化完成：即时 reconcile + 降低轮询兜底从 15s → 5s
> **Updated At**: 2026-07-24
> **Source**: 性能提升任务
> **Target**: 消除 campaign 状态跃迁的 15s 轮询等待，改为事件驱动即时推进
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- ✅ `accept_campaign` 补充 `ensureControllerDaemon` 调用，确保 daemon 在运行。
- ✅ `submit_campaign_review` 和 `resume_campaign` 跃迁到 active 后立即调 `reconcileCampaign`，消除最坏 15s 等待。
- ✅ 兜底轮询间隔从 15s 降至 5s（`ACTIVE_CAMPAIGN_RECONCILE_INTERVAL_MS`），环境变量可覆盖。

## Performance Impact

**Before**: task 完成 → 最坏等 15s → reconcile 推进下一 task
**After**: task 完成 → wakeScheduler 唤醒（<250ms）→ campaign 状态跃迁立即 reconcile → 推进下一 task；兜底轮询降至 5s

端到端延迟从「最坏 15s」降至「通常 <1s，兜底 5s」。

## Validation Completed

- `bun tsc --noEmit`: 0 errors.
- `bun test tests/runtime/chatgpt-supervised-campaign.test.ts`: 16 pass.
- `bun test tests/runtime/campaign-*.test.ts`: 21 pass total.
- `bun scripts/inspect-project-state.ts --repo . --format text`.
- `bash scripts/migrate-project-template.sh --repo . --dry-run`.
- Historical stuck-state migration: four false completions reopened, zero remaining false completions, four `integration_blocked`, zero `cleanup_blocked`.
- Protected recovery files remain present at `/private/tmp/repo-harness-quarantine-node-modules.txt` and `/private/tmp/repo-harness-terminal-issue-files.nul`.

## Remaining Before Delivery

- Pass the task-sync gate with this updated snapshot and complete the final independent Claude review.
- Commit the final lifecycle/Worker corrections, fast-forward `main`, and push `origin/main`.
- Install the immutable release from final `main`; confirm the live release revision matches `main`.
- Run real repository-command twice, Local Job once, minimal Task lifecycle, drift-gate, cleanup, and orphan-Worker acceptance.
