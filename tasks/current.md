# Current Status Snapshot

<!-- updated_at: 2026-07-18 -->
<!-- stale_after: 24h -->

> **Status**: Canonical stable-baseline recovery is implementation-complete and awaiting final integration/release acceptance
> **Updated At**: 2026-07-18
> **Source**: Codex `/goal` canonical stable-baseline recovery
> **Target**: Preserve historical work, make Task completion evidence-exact, keep detached Workers durable, and verify the stable runtime
> **Stale After**: 24h

This snapshot is a read model, not an execution gate.

## Current Focus

- New business Task execution remains frozen while the recovery branch is validated and delivered.
- Historical recovery classified nine candidate work lines: three rescued into the canonical baseline, four superseded or patch-equivalent, and two intentionally retained without merge. The 453 historical Direct Edit sessions remain preserved as evidence.
- Four historical Tasks incorrectly labeled `done` were reopened as `integration_blocked`; no cleanup-only blocker remains.
- Task completion now requires a reachable target revision plus persisted verification, integration, and cleanup evidence. The unified finalizer owns integration, final verification, Run termination, cleanup, and Task acceptance.
- Same-path source drift blocks integration while unrelated source changes remain eligible. Pending integration is indexed instead of scanning bounded Run history.
- Detached repository-command Workers remain valid after reparenting to PID 1. The narrow ownership exception applies only after the child command exits and the owned auto-finalizer is running; ordinary execution still fails closed on ownership loss.
- The Stable Supervisor, local Gateway/control endpoints, public MCP health, OAuth discovery, and the separately launchd-managed Cloudflare tunnel are healthy. The historical 502 window was local origin downtime rather than tunnel ownership failure.

## Validation Completed

- `bun test`: 1678 passed, 0 failed, 12293 assertions across 197 files.
- `bunx tsc --noEmit`.
- `bash scripts/check-deploy-sql-order.sh`.
- `bash scripts/check-architecture-sync.sh`.
- `bash scripts/check-task-workflow.sh --strict` (source/document contracts pass; ignored generated runtime bootstrap advisories remain).
- `bun scripts/inspect-project-state.ts --repo . --format text`.
- `bash scripts/migrate-project-template.sh --repo . --dry-run`.
- Historical stuck-state migration: four false completions reopened, zero remaining false completions, four `integration_blocked`, zero `cleanup_blocked`.
- Protected recovery files remain present at `/private/tmp/repo-harness-quarantine-node-modules.txt` and `/private/tmp/repo-harness-terminal-issue-files.nul`.

## Remaining Before Delivery

- Pass the task-sync gate with this updated snapshot and complete the final independent Claude review.
- Commit the final lifecycle/Worker corrections, fast-forward `main`, and push `origin/main`.
- Install the immutable release from final `main`; confirm the live release revision matches `main`.
- Run real repository-command twice, Local Job once, minimal Task lifecycle, drift-gate, cleanup, and orphan-Worker acceptance.
