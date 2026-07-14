# Current Status Snapshot

<!-- updated_at: 2026-07-14 -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-14
> **Source**: Controller runtime stability review
> **Target**: Remove hot-path blocking probes and stale projection churn so MCP / Connector sessions stay responsive during long-lived controller operation
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- 插件动作完成后不再全量重建所有 plugin manifest；改为仅刷新被修改插件，避免 GitHub/Gmail 配置作业被无关 iOS probe 拖慢。
- iOS Xcode/simctl 降级探测改为短 TTL 缓存，并把热路径单次 probe 收紧到 1 秒级，避免 `list_plugins` / `controller_context` / readiness 反复阻塞。
- GitHub configure 写入后注入短寿命状态缓存，配置动作和紧随其后的 manifest 刷新不再同步阻塞在 `gh` readiness probe。
- `controller_context` 直读路径现在会在 projection 缺失、结构不完整或过旧时刷新持久化 projection，修复 context projection 长时间 stale。
- 启动恢复仅在 projection 缺失或 dirty 时重建 runtime projection，避免 daemon restart 后为每个仓库无差别重算。
- Controller tool exposure、local bridge snapshot、plugin manifest 热读均增加缓存，降低重复 schema/build 与扫描开销。

## Validation Completed

- `bun test tests/runtime/ios-development-tooling.test.ts tests/runtime/personal-assistant-plugin-runtime.test.ts tests/runtime/browser-plugin.test.ts tests/runtime/local-system-plugin.test.ts tests/runtime/runtime-recovery-command-argv.test.ts tests/cli/mcp-controller.test.ts`
- `bun test tests/cli/mcp-controller.test.ts --test-name-pattern "lists plugin manifests and routes typed plugin actions through durable execution"`
- `bun test tests/migration-script.test.ts --test-name-pattern "apply mode treats repo paths as argv and does not evaluate shell metacharacters"`
- `bun test tests/migration-script.test.ts --test-name-pattern "should apply migration and create workflow artifacts with single-source plan workflow"`
- `bun test tests/migration-script.test.ts --test-name-pattern "should migrate legacy trackable _ops assets into deploy while preserving private _ops state"`
- `bun test tests/cli/local-bridge-ephemeral-v7.test.ts`
- `bun test tests/cli/codex-command-builder.test.ts`
- `bun test` 长跑抽样曾暴露 migration apply 长测在高负载下超时；对应 3 条用例单独复跑均在约 4.4-4.8s 内通过。

## Remaining Before Delivery

- 全量 `bun test` 仍存在套件级负载敏感项，建议后续把 migration apply 长测拆分到单独 lane，或为其定义明确的高负载超时预算。
- 仍需继续观察大型仓库上的 `rh_context` / `controller_context_pack`，插件与 projection 热路径已降温，但 Git/filesystem 聚合在超大仓库上仍可能成为下一瓶颈。
