# Current Status Snapshot

<!-- updated_at: 2026-07-11 -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-11
> **Source**: Local-bridge GUI repository registry management
> **Target**: Support soft-removing registered repositories from the console without deleting disk files
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- GUI 仓库页支持「删除注册」：调用 soft-remove，保留审计历史，不删磁盘文件。
- Local-bridge 暴露 `POST /api/repositories/:repoId/remove`。
- 列表默认隐藏已 soft-remove 的仓库；当前选中被删时自动切到剩余仓库。
- 自我保护：不能删除当前进程所在仓库的注册。

## Validation Completed

- `bun test tests/cli/local-bridge.test.ts --test-name-pattern "registers and soft-removes|hardened localhost"`

## Remaining Before Delivery

- Optional: deeper routing drag-and-drop editor (current shows ordered lists + API updates).
- Live HTTP adapters for remote APIs remain gated.
