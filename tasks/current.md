# Current Status Snapshot

<!-- updated_at: 2026-07-11 -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-11
> **Source**: MCP controller connectivity repair
> **Target**: Restore stable ChatGPT Connector tool scanning and live MCP health
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- 修复近期 access-mode/toolset 改动导致的 MCP 工具面膨胀：默认 core 回到 11 个工具，advanced 回到 78 个工具，full 保留兼容全集。
- 默认 core 保留统一 `rh_access` 和 `repository_access_get`；`repository_access_preview` / `repository_access_set` 仅在 advanced/full 暴露。
- `toolsetLocked` 对缺省测试/诊断 context 采用兼容默认值，避免 advanced 误降级为 request/core。
- HTTP smoke 不再硬编码过期工具数和 fingerprint，改为从实际工具面常量与 `runtimePolicy` 计算预期。
- 已重启 live MCP，当前 endpoint: `https://greysons-macbook-air.tail95bb5c.ts.net/mcp`。

## Validation Completed

- `bun run check:mcp-compatibility`
- `bun test tests/cli/mcp-tool-exposure-profiles.test.ts tests/cli/connector-freshness.test.ts`
- `bun scripts/smoke-mcp-tool-surface.ts`
- `bun test tests/cli/mcp-http.test.ts`
- `bun run smoke:mcp-http-runtime`
- `repo-harness mcp restart --repo .`
- `repo-harness mcp doctor --repo .`
- `curl http://127.0.0.1:8765/health` -> `toolset=advanced`, `toolCount=78`, `status=ok`
- `curl https://greysons-macbook-air.tail95bb5c.ts.net/.well-known/oauth-protected-resource/mcp` -> OAuth resource metadata ok

## Remaining Before Delivery

- ChatGPT side must recreate or rescan the Connector named `repo-harness-controller-runtime`, then call `controller_capabilities`.
- Existing unrelated local MCP/local-bridge edits remain in the worktree and were not reverted.
