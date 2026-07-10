---
id: "ISS-20260710-A0D1D3"
kind: "governance"
status: "done"
updated_at: "2026-07-10T11:43:24.985Z"
archived_at: "2026-07-10T11:43:24.985Z"
source: "repo-harness-controller-v8"
---

# Controller execution and governance convergence

Close the remaining command lifecycle, governance projection, and integration-recovery defects with isolated parallel tasks and focused checks.

## Goals

- Make parent Execution Job state truthfully follow child Local Job lifecycle and configured deadlines.
- Reduce governance state debt through deterministic reconciliation and bounded user-facing projections.
- Make agent integration recognize already-integrated results and recover safely from concurrent main changes.

## Non-goals

- Do not change MCP default tool exposure; that is owned by ISS-20260710-57BB3C.
- Do not change keepalive/Gateway restart policy; that is owned by ISS-20260709-1064D1.
- Do not add broad new product capabilities or expand the full test suite.

## Acceptance Criteria

- [ ] Each task is implemented in an isolated worktree with non-overlapping source ownership.
- [ ] Focused tests and package:check:type pass for every task.
- [ ] Each branch is committed, reviewed, integrated into main, and cleaned.
- [ ] No unrelated existing work or untracked Issue files are modified.

## GitHub

- Not published.

## Tasks

### T1 — Fix repository command and Local Job lifecycle propagation

- Status: `superseded`
- Objective: Fix repository_command_execute timeout validation and parent/child lifecycle propagation in the concrete repository-tool, Gateway and Local Job storage/recovery implementation. Explicit timeouts must support the shared maximum used by agent execution. Parent durable Execution Job remains non-terminal while the Local Job child is queued/running, wait=true follows the child to a real terminal state, and restart/reconciliation preserves a still-live detached child. Add dedicated regression tests, run focused checks and commit.
- Depends on: none
- Allowed paths: `src/cli/mcp/repository-tools.ts`, `src/runtime/gateway/mcp/router.ts`, `src/runtime/gateway/mcp/runtime-tools.ts`, `src/cli/local-bridge/job-store.ts`, `src/runtime/recovery/local-jobs-repair.ts`, `src/runtime/execution/**`, `tests/runtime/repository-command-lifecycle.test.ts`, `tests/cli/repository-command-lifecycle.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T2 — Reconcile governance state and simplify active attention

- Status: `superseded`
- Objective: Implement deterministic governance reconciliation in the concrete issue/governance/projection files. A later successful run must remove stale failed-run blockers; completed or verified work closes according to policy; terminal issues are surfaced for archive; historical attention is separated from current attention. Keep detailed internal states but return a bounded user-facing status model. Add a dedicated test file, run focused checks and commit.
- Depends on: none
- Allowed paths: `src/cli/controller/governance.ts`, `src/cli/controller/issue-store.ts`, `src/runtime/projections/controller-context.ts`, `src/runtime/projections/invalidation.ts`, `src/runtime/projections/materialized-view.ts`, `tests/cli/governance-reconciliation.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T3 — Harden already-integrated and concurrent integration recovery

- Status: `superseded`
- Objective: Improve isolated Task Run integration and finish flow only in the agent-job integration/editing/completion files. Detect when equivalent changes or commits already exist on main and record already_integrated instead of failing. When main changed concurrently, preserve both sides and produce a bounded conflict/review packet rather than replaying stale hashes or overwriting files. Ensure successful finish commits, integrates and cleans worktree/branch atomically where safe. Add a dedicated test file, run focused checks and commit.
- Depends on: none
- Allowed paths: `src/cli/agent-jobs/integration.ts`, `src/cli/agent-jobs/job-worker.ts`, `src/cli/agent-jobs/job-manager.ts`, `src/cli/agent-jobs/types.ts`, `src/cli/editing/edit-session.ts`, `src/cli/controller/completion-backlog.ts`, `src/cli/controller/completion-orchestrator.ts`, `src/cli/controller/progress.ts`, `tests/cli/task-integration-recovery.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T4 — Close verified execution and governance convergence

- Status: `done`
- Objective: Record main integration and verification for repository command lifecycle, governance reconciliation, integration recovery, lease self-lock prevention, and daemon ownership fencing.
- Depends on: none
- Allowed paths: `src/cli/agent-jobs/**`, `src/cli/controller/**`, `src/cli/local-bridge/job-store.ts`, `src/cli/repositories/command-executor.ts`, `src/runtime/control-plane/**`, `src/runtime/execution/**`, `src/runtime/recovery/**`, `tests/cli/**`, `tests/runtime/**`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:release-readiness`
- Execution hint: agent / codex

## Related Artifacts

- None.
