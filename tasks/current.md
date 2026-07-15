# Current Status Snapshot

<!-- updated_at: 2026-07-15 -->
<!-- stale_after: 24h -->

> **Status**: Runtime Source isolation merged locally
> **Updated At**: 2026-07-15
> **Source**: ISS-20260715-9E34AD runtime source identity isolation
> **Target**: Prevent false RUNTIME_SOURCE_SNAPSHOT_STALE when selecting business execution repositories
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Controller Runtime Source Identity is controller-scoped and resolved from package/source authority, not the selected execution repository.
- MCP `rh_status`, CLI controller status, and Local Bridge access state share `evaluateActiveRuntimeSourceDrift`.
- Daemon/keepalive pin `REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT` so ambient business cwd cannot redefine generation.

## Validation Completed

- `bun test tests/runtime/runtime-source-isolation.test.ts tests/cli/controller-runtime-status.test.ts tests/runtime/facade-mcp-surface.test.ts`
- `bun run check:type`

## Remaining Before Delivery

- Restart a live controller so new generation captures package-derived Runtime Source; existing generation records remain compatible for comparison.
- Optional follow-up: packaged/global installs without git metadata still resolve package root, but branch/commit drift signals may be limited.
