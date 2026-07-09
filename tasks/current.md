# Current Status Snapshot

<!-- updated_at: 2026-07-09T00:00:00Z -->
<!-- stale_after: 24h -->

> **Status**: Ready for Delivery
> **Updated At**: 2026-07-09
> **Source**: connector freshness diagnostics fix
> **Target**: stop vague ChatGPT connector missing-facade warnings when GUI cannot observe connector tools
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Local Controller GUI connector freshness now distinguishes local MCP tool surface vs ChatGPT connector snapshot.
- Vague “可能缺少新 facade 工具，请重连 MCP” is removed; unobserved ChatGPT snapshots show 未确认 (info), not 缺少.
- Self-test endpoints: `GET /api/console/connector/status`, `POST /api/console/connector/check`.
- Smoke: `bun scripts/smoke-mcp-tool-surface.ts`.

## Validation Completed

- `npm run check:type`
- `bun test tests/cli/connector-freshness.test.ts`
- `bun test tests/cli/console-facade-api.test.ts`
- `bun test tests/cli/controller-chatgpt-bridge-v8.test.ts`
- `bun test tests/cli/local-bridge.test.ts`
- `bun scripts/smoke-mcp-tool-surface.ts`

## Remaining Before Delivery

- None for this slice. GUI still cannot invent ChatGPT tool lists without `connector_tool_names`.
