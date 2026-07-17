# Current Status Snapshot

<!-- updated_at: 2026-07-17 -->
<!-- stale_after: 24h -->

> **Status**: Stable External Runtime Supervisor repair accepted on main
> **Updated At**: 2026-07-17
> **Source**: plans/plan-20260716-stable-external-runtime-supervisor.md
> **Target**: Make the immutable external Supervisor the primary lifecycle/recovery owner while preserving existing authorities and compatibility fallbacks
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- Stable Supervisor release handoff now replaces stale healthy Daemon/Gateway children when the current immutable release changes.
- Real-machine acceptance covers user LaunchAgent installation, bounded launchd bootstrap retry/recovery, stable ingress/control health, and one exact Daemon plus one exact Gateway recovery.
- Runtime storage relocation is finalized; safe historical Run/worktree cleanup and a repository-command Local Job completed without the Durable Job gate blocking synchronous recovery.
- Controller Runtime Source Identity is controller-scoped and resolved from package/source authority, not the selected execution repository.
- MCP `rh_status`, CLI controller status, and Local Bridge access state share `evaluateActiveRuntimeSourceDrift`.
- Daemon/keepalive pin `REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT` so ambient business cwd cannot redefine generation.

## Validation Completed

- `bun x tsc --noEmit`
- `bun test tests/runtime/interactive-sync-router.test.ts`
- `bun test tests/runtime/stable-supervisor-hardening.test.ts`
- `bun test tests/runtime/stable-supervisor-integration.test.ts`
- `git diff --check`
- Real immutable release acceptance: Supervisor/Daemon/Gateway all on one release revision, stable ingress `8765`, control `8770`, `/health`, `/rescue/health`, exact Daemon recovery, exact Gateway recovery, and consistent generation.

## Remaining Before Delivery

- Final `main` is pushed, the repair branch/worktree is removed, and the live release was reinstalled from `main`.
- Final live release revision equals `main` short SHA; working tree is clean.
