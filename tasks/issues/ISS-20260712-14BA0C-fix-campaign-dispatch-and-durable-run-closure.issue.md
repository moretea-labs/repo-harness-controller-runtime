---
id: "ISS-20260712-14BA0C"
kind: "investigation"
status: "planned"
updated_at: "2026-07-12T12:29:08.884Z"
source: "repo-harness-controller-v8"
---

# Fix Campaign dispatch and durable Run closure

Work directly in the canonical current checkout on main. First fix Campaign quick-agent dispatch so task title/objective are propagated and workspace.mode=current with arguments.isolate=false is honored instead of being forced to an isolated worktree. Add regression tests. Then implement durable Run closure: explicit integration/cleanup state, no premature succeeded terminal state, restart-resumable and idempotent finish, safe worktree/temporary branch cleanup, preservation with explicit reasons for dirty/active/protected/unknown/unmerged cases, historical orphan reconciliation, main-occupancy diagnosis, and Needs Attention projection. Inspect exact relevant source only, run focused tests, package:check:type and package:check:controller-v8, commit locally on main, leave clean, do not push.

## Goals

- Work directly in the canonical current checkout on main. First fix Campaign quick-agent dispatch so task title/objective are propagated and workspace.mode=current with arguments.isolate=false is honored instead of being forced to an isolated worktree. Add regression tests. Then implement durable Run closure: explicit integration/cleanup state, no premature succeeded terminal state, restart-resumable and idempotent finish, safe worktree/temporary branch cleanup, preservation with explicit reasons for dirty/active/protected/unknown/unmerged cases, historical orphan reconciliation, main-occupancy diagnosis, and Needs Attention projection. Inspect exact relevant source only, run focused tests, package:check:type and package:check:controller-v8, commit locally on main, leave clean, do not push.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] Campaign direct-current quick agent works
- [ ] Run closure is durable and safe
- [ ] Tests pass
- [ ] Local main commit created
- [ ] No push

## GitHub

- Not published.

## Tasks

### T1 — Fix Campaign dispatch and durable Run closure

- Status: `blocked`
- Objective: Work directly in the canonical current checkout on main. First fix Campaign quick-agent dispatch so task title/objective are propagated and workspace.mode=current with arguments.isolate=false is honored instead of being forced to an isolated worktree. Add regression tests. Then implement durable Run closure: explicit integration/cleanup state, no premature succeeded terminal state, restart-resumable and idempotent finish, safe worktree/temporary branch cleanup, preservation with explicit reasons for dirty/active/protected/unknown/unmerged cases, historical orphan reconciliation, main-occupancy diagnosis, and Needs Attention projection. Inspect exact relevant source only, run focused tests, package:check:type and package:check:controller-v8, commit locally on main, leave clean, do not push.
- Depends on: none
- Allowed paths: `src/runtime/workflow/campaigns/**`, `src/cli/agent-jobs/**`, `src/runtime/execution/**`, `src/runtime/integration/**`, `src/runtime/recovery/**`, `src/runtime/projections/**`, `src/cli/repositories/**`, `src/cli/controller/**`, `src/cli/local-bridge/**`, `tests/runtime/**`, `tests/cli/**`, `docs/**`, `package.json`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
