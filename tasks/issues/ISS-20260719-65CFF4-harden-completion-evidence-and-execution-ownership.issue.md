---
id: "ISS-20260719-65CFF4"
kind: "bug"
status: "done"
updated_at: "2026-07-19T04:04:58.954Z"
source: "repo-harness-controller-v8"
---

# Harden completion evidence and execution ownership

Completed compatibility-preserving hardening of acceptance provenance, WorkContract completion evidence, and operation receipt ownership fencing. Full package:test passed. Release Readiness reaches the pre-existing open-source audit blocker in stable-supervisor-hardening.test.ts personal macOS path fixtures; no blocker was introduced by this issue.

## Goals

- Successful Runs must not fabricate passed acceptance criteria.
- Missing acceptance evidence must remain incomplete rather than become a failure or false success.
- WorkContract finalization must require meaningful verification/execution evidence; worktree refs and patch proposals alone are insufficient.
- Operation receipts must be bound to the current attempt and Worker ownership before recovery can trust them.
- Task/Work completion must never elevate access mode or satisfy remote/destructive authorization.

## Non-goals

- Do not replace all legacy ok:boolean fields in one migration.
- Do not reopen all historical terminal tasks automatically.
- Do not redesign plugin authorization or access-mode architecture without a confirmed bypass.
- Do not refactor unrelated scheduler, projection, supervisor, or runtime GC code.

## Acceptance Criteria

- [ ] All automatic completion producers record acceptance as not evaluated rather than passed.
- [ ] Explicit reviewer/human acceptance remains backward compatible and trusted.
- [ ] Incomplete acceptance maps to verifying/review, explicit failure maps to changes_requested, and passed maps to verified.
- [ ] WorktreeRef, workerRef, patch proposal, or arbitrary checkRef alone cannot finalize WorkContract succeeded.
- [ ] Stale receipt attempt/PID data is rejected or ignored during write and recovery.
- [ ] Targeted tests and package checks pass; final code is merged to main and isolated resources are cleaned.

## GitHub

- Not published.

## Tasks

### T1 — Make acceptance evidence provenance-aware

- Status: `done`
- Objective: Implement a backward-compatible acceptance evidence model. Preserve ok:boolean for callers and stored data, add optional outcome/source provenance, stop successful Run completion and legacy auto-completion paths from fabricating passed acceptance, normalize recognizable legacy auto-generated evidence as not_evaluated, and distinguish passed/failed/incomplete in verification gating. Map incomplete to verifying rather than changes_requested. Update progress projection and all directly affected tests. Do not reopen historical terminal Tasks automatically and do not weaken high/destructive human acceptance gates.
- Depends on: none
- Allowed paths: `src/cli/controller/types.ts`, `src/cli/controller/execution-policy.ts`, `src/cli/controller/issue-store.ts`, `src/cli/controller/execution-completion.ts`, `src/cli/controller/completion-orchestrator.ts`, `src/cli/controller/progress.ts`, `src/cli/local-controller/server.ts`, `src/cli/mcp/legacy-tool-service.ts`, `tests/cli/task-execution-policy.test.ts`, `tests/cli/automatic-completion.test.ts`, `tests/cli/completion-orchestrator.test.ts`, `tests/cli/controller-lifecycle.test.ts`, `tests/cli/local-controller.test.ts`, `tests/cli/tool-service.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T2 — Require meaningful WorkContract completion evidence

- Status: `done`
- Objective: Replace weak boolean completion evidence in goal-workloop with a bounded evaluator. WorktreeRef alone, workerRef alone, any arbitrary checkRef, or a Codex/Claude patch proposal must never be sufficient for WorkContract succeeded. Require all declared checks to have valid_pass; classify valid_fail as failed and infrastructure/invalid/skipped/missing as incomplete. Preserve read-only/no-check compatibility conservatively, retain explicit waiting_for_review with actionable reasons when mutating completion evidence is absent, and add regression tests. Do not redesign all WorkContract schema or introduce broad migrations.
- Depends on: `T1`
- Allowed paths: `src/runtime/control-plane/facade/types.ts`, `src/runtime/control-plane/facade/goal-workloop.ts`, `src/runtime/control-plane/facade/codex-delegation.ts`, `src/runtime/control-plane/facade/work-contract-store.ts`, `tests/runtime/goal-workloop.test.ts`, `tests/runtime/codex-delegation.test.ts`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

### T3 — Fence operation receipts and verify authorization isolation

- Status: `done`
- Objective: Harden OperationReceipt writes and recovery with current attempt and Worker ownership validation. Preserve schema compatibility through additive metadata only where needed. Ignore stale receipts from replacement attempts/PIDs; keep terminal Job transition fencing intact. Add race/recovery tests and focused regression tests proving Task/Work success does not satisfy access, remote-write, destructive, or strong-confirmation authorization. Avoid broad plugin changes unless a concrete bypass is demonstrated.
- Depends on: `T2`
- Allowed paths: `src/runtime/execution/jobs/receipt-store.ts`, `src/runtime/execution/jobs/child-reference.ts`, `src/runtime/execution/workers/worker-entry.ts`, `src/runtime/control-plane/global-scheduler/reconciliation.ts`, `src/runtime/control-plane/facade/goal-workloop-access.ts`, `tests/runtime/agent-delegation-lifecycle.test.ts`, `tests/runtime/goal-workloop.test.ts`, `tests/runtime/target-architecture.test.ts`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `ea856e1b acceptance provenance`
- `f4ca6063 meaningful WorkContract evidence`
- `7cedea46 receipt ownership fencing`
- `package:test succeeded EVD-1784433805346-0e12ae9b`
- `release-readiness pre-existing audit blocker EVD-1784433170746-d946fbdf`
