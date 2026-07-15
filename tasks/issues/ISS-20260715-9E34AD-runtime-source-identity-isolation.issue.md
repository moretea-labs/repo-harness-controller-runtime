---
id: "ISS-20260715-9E34AD"
kind: "bug"
status: "done"
updated_at: "2026-07-15T12:45:00.000Z"
source: "repo-harness-controller-v8"
---

# Isolate Controller Runtime Source Identity from execution repositories

## Summary

Selecting a business execution repository (different root/branch from the controller runtime package) falsely triggered `RUNTIME_SOURCE_SNAPSHOT_STALE`, degraded readiness, and blocked mutating operations. Root cause was incorrect drift comparison against execution `canonicalRoot`, not runtime generation overwrite.

## Goals

- Keep Runtime Source Identity controller-scoped and package/source-derived.
- Ensure MCP, CLI, and Local Bridge share one drift evaluation path.
- Preserve true runtime dirty/commit/root drift protection and fail-closed missing snapshots.

## Non-goals

- Do not change business project execution logic.
- Do not require runtime root to equal execution root.
- Do not delete genuine runtime dirty checks.

## Acceptance Criteria

- [x] Execution repository selection does not set `RUNTIME_SOURCE_SNAPSHOT_STALE`.
- [x] Session/repository switch does not rotate runtime generation.
- [x] True runtime source change still blocks mutating readiness.
- [x] Missing snapshot returns structured fail-closed error.
- [x] Targeted isolation tests and typecheck pass.

## Tasks

### T1 — Runtime Source isolation fix

- Status: `done`
- Objective: Introduce unique runtime source resolver; stop comparing execution repository roots; pin daemon/keepalive startup source; add targeted tests and architecture invariant.
- Checks: `bun test tests/runtime/runtime-source-isolation.test.ts tests/cli/controller-runtime-status.test.ts tests/runtime/facade-mcp-surface.test.ts`, `bun run check:type`

## Related Artifacts

- `src/runtime/control-plane/runtime-generation.ts`
- `docs/architecture/current/architecture-invariants.md` Invariant 26
- `tests/runtime/runtime-source-isolation.test.ts`
