# Current Status Snapshot

<!-- updated_at: 2026-07-16 -->
<!-- stale_after: 24h -->

> **Status**: Stable External Runtime Supervisor implementation in progress on feature branch
> **Updated At**: 2026-07-16
> **Source**: plans/plan-20260716-stable-external-runtime-supervisor.md
> **Target**: Make the immutable external Supervisor the primary lifecycle/recovery owner while preserving existing authorities and compatibility fallbacks
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Stable Supervisor release bundles, durable operation state, identity fencing, restart budgets, Rescue MCP, lifecycle bridge, and facade operations are implemented in the isolated worktree.
- Real-machine smoke evidence covers stable bundle startup, `--tunnel none`, authenticated Rescue MCP, durable gateway restart, and automatic Daemon/Gateway recovery after external termination.
- Controller Runtime Source Identity is controller-scoped and resolved from package/source authority, not the selected execution repository.
- MCP `rh_status`, CLI controller status, and Local Bridge access state share `evaluateActiveRuntimeSourceDrift`.
- Daemon/keepalive pin `REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT` so ambient business cwd cannot redefine generation.

## Validation Completed

- `bun x tsc --noEmit --pretty false`
- `bun test tests/runtime/stable-supervisor-contract.test.ts tests/runtime/stable-supervisor-rescue.test.ts tests/runtime/facade-contracts.test.ts tests/cli/controller-restart-coordinator.test.ts tests/cli/controller-runtime-status.test.ts tests/runtime/control-plane-hardening.test.ts`
- Real temporary Controller Home smoke: immutable release, loopback Rescue MCP, operation persistence, Gateway restart, and Daemon/Gateway auto-recovery.
- `bun test tests/runtime/runtime-source-isolation.test.ts tests/cli/controller-runtime-status.test.ts tests/runtime/facade-mcp-surface.test.ts`
- `bun run check:type`

## Remaining Before Delivery

- Run the full repository checks, review generated architecture/task projections, and merge the isolated feature branch.
- Restart a live controller so new generation captures package-derived Runtime Source; existing generation records remain compatible for comparison.
- Optional follow-up: packaged/global installs without git metadata still resolve package root, but branch/commit drift signals may be limited.
