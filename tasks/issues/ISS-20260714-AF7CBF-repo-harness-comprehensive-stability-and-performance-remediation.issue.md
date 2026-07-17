---
id: "ISS-20260714-AF7CBF"
kind: "investigation"
status: "launch_blocked"
updated_at: "2026-07-17T09:47:16.706Z"
source: "repo-harness-controller-v8"
---

# Repo Harness comprehensive stability and performance remediation

Completed comprehensive stability, performance, workflow, connector diagnostics, restart coordination, Campaign workspace, durable Run closure, and cancellation cleanup remediation. All required focused gates pass; the single final portable full test exposed two residual failures that were fixed and verified with focused and adjacent regression suites. Changes are merged to clean main, completed worktrees/branches were removed, three watchdog-approved stale test daemons were terminated, and no remote push was performed.

## Goals

- Work from the exact current repository state and complete one cohesive remediation, not a partial diagnosis. First verify the current HEAD and current failures. Fix all confirmed issues in scope: (1) TypeScript failure in tests/cli/console-facade-api.test.ts where center.plugins may be undefined; fix production typing or test narrowing appropriately, not with unsafe casts. (2) Fix the runtime architecture invariant violation in src/runtime/gateway/mcp/router.ts: controller_context must use the materialized projection or a Durable Execution Job and must never fall through to the legacy Gateway execution path. Preserve bounded hot reads and compatibility. (3) Make controller check caching transparent and trustworthy: add backward-compatible optional metadata to results/evidence/jobs so callers can distinguish a cache hit from a new process execution and see validated/current revision and original executedAt; keep the existing content-bound cache semantics. Add tests. (4) Correct check failure classification end to end: a named check returning a normal nonzero status is an acceptance/validation failure, not an infrastructure failure; timeouts, spawn failures, missing runtime, and corrupt state remain infrastructure failures. Preserve exact error details through Local Job -> ExecutionJob -> rh_work result summaries. Add regression tests. (5) Make rh_context detail_level=summary genuinely bounded: do not return the full 124-tool list, all checks, and large historical Work/Job arrays by default. Return counts, readiness, selected/requested checks, active attention and bounded recent summaries. Keep detail/raw compatibility and add a strict response-size/shape test. (6) Make tool-surface diagnostics honest: local expected/actual registry parity must not claim connector callability. Add explicit scope/state such as local registry verified and connector callability unverified unless an external callability probe exists; an exposed-but-UNKNOWN_TOOL call must be representable as connector mismatch. Update readiness/doctor tests and docs only where needed. (7) Fix package:check:task-workflow for this repository without committing runtime-generated state: separate missing bootstrap/runtime files from tracked document contract defects, ensure the check is read-only with respect to tracked files, add the required Status lines to the identified PRD and Sprint where appropriate, and produce an actionable bootstrap/remediation message for missing .ai runtime files and stale resume packets. Do not weaken strict checking globally merely to make this repository pass. (8) Review the surrounding implementations for activeWork/recentExecutionJobs/history limits and stale campaign/review counts; fix hot-read scanning or default payload expansion where directly responsible, but do not delete user history. Validate no regression in projection recovery and managed worktree cleanup. Run focused tests while editing, then package:check:type, package:check:runtime-architecture, package:check:task-workflow, package:check:controller-v8, and finally package:test once. Do not stop after the first failure: continue fixing until all in-scope checks pass or provide exact irreducible blockers with evidence. Do not modify or commit _ops/**, .ai/harness/checks/**, .ai/harness/local-jobs/**, .ai/harness/jobs/**, node_modules/**, or dist/**. Do not push remote. Leave a clean, reviewable isolated worktree and a complete handoff with changed files, test results, remaining risks, and rollback notes.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] All confirmed current defects are addressed in one cohesive patch rather than a one-error fix.
- [ ] package:check:type passes.
- [ ] package:check:runtime-architecture passes and controller_context cannot execute through the legacy Gateway path.
- [ ] package:check:task-workflow is read-only for tracked files, distinguishes missing generated bootstrap state from source defects, and passes after the supported local bootstrap/remediation path without committing runtime state.
- [ ] Check results expose cache-hit provenance and classify normal assertion failures separately from infrastructure failures.
- [ ] rh_context summary is materially smaller and bounded while detail/raw remain compatible.
- [ ] Tool diagnostics distinguish local registry parity from actual connector callability.
- [ ] package:check:controller-v8 passes.
- [ ] package:test passes once at the end, or any irreducible external blocker is proven with exact evidence.
- [ ] No forbidden runtime/generated paths are committed and the worktree is clean for review.

## GitHub

- Not published.

## Tasks

### T1 — Repo Harness comprehensive stability and performance remediation

- Status: `done`
- Objective: Work from the exact current repository state and complete one cohesive remediation, not a partial diagnosis. First verify the current HEAD and current failures. Fix all confirmed issues in scope: (1) TypeScript failure in tests/cli/console-facade-api.test.ts where center.plugins may be undefined; fix production typing or test narrowing appropriately, not with unsafe casts. (2) Fix the runtime architecture invariant violation in src/runtime/gateway/mcp/router.ts: controller_context must use the materialized projection or a Durable Execution Job and must never fall through to the legacy Gateway execution path. Preserve bounded hot reads and compatibility. (3) Make controller check caching transparent and trustworthy: add backward-compatible optional metadata to results/evidence/jobs so callers can distinguish a cache hit from a new process execution and see validated/current revision and original executedAt; keep the existing content-bound cache semantics. Add tests. (4) Correct check failure classification end to end: a named check returning a normal nonzero status is an acceptance/validation failure, not an infrastructure failure; timeouts, spawn failures, missing runtime, and corrupt state remain infrastructure failures. Preserve exact error details through Local Job -> ExecutionJob -> rh_work result summaries. Add regression tests. (5) Make rh_context detail_level=summary genuinely bounded: do not return the full 124-tool list, all checks, and large historical Work/Job arrays by default. Return counts, readiness, selected/requested checks, active attention and bounded recent summaries. Keep detail/raw compatibility and add a strict response-size/shape test. (6) Make tool-surface diagnostics honest: local expected/actual registry parity must not claim connector callability. Add explicit scope/state such as local registry verified and connector callability unverified unless an external callability probe exists; an exposed-but-UNKNOWN_TOOL call must be representable as connector mismatch. Update readiness/doctor tests and docs only where needed. (7) Fix package:check:task-workflow for this repository without committing runtime-generated state: separate missing bootstrap/runtime files from tracked document contract defects, ensure the check is read-only with respect to tracked files, add the required Status lines to the identified PRD and Sprint where appropriate, and produce an actionable bootstrap/remediation message for missing .ai runtime files and stale resume packets. Do not weaken strict checking globally merely to make this repository pass. (8) Review the surrounding implementations for activeWork/recentExecutionJobs/history limits and stale campaign/review counts; fix hot-read scanning or default payload expansion where directly responsible, but do not delete user history. Validate no regression in projection recovery and managed worktree cleanup. Run focused tests while editing, then package:check:type, package:check:runtime-architecture, package:check:task-workflow, package:check:controller-v8, and finally package:test once. Do not stop after the first failure: continue fixing until all in-scope checks pass or provide exact irreducible blockers with evidence. Do not modify or commit _ops/**, .ai/harness/checks/**, .ai/harness/local-jobs/**, .ai/harness/jobs/**, node_modules/**, or dist/**. Do not push remote. Leave a clean, reviewable isolated worktree and a complete handoff with changed files, test results, remaining risks, and rollback notes.
- Depends on: none
- Allowed paths: `src/**`, `scripts/**`, `tests/**`, `docs/**`, `plans/**`, `tasks/**`, `package.json`, `.repo-harness/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:task-workflow`, `package:check:controller-v8`, `package:test`
- Execution hint: agent / codex

### T2 — Harden restart coordination and post-restart recovery

- Status: `cancelled`
- Objective: Implement one authoritative restart protocol for all repo-harness restart entry points. A restart requested from MCP, Local Bridge, Local Job, Controller Daemon child, CLI, or scripts must never depend on a process that the restart will terminate. Use a detached out-of-band coordinator with durable controllerHome state, idempotency/locking, bounded delayed execution, phase/error recording, and post-start verification. Unify scripts/controller-runtime.sh, controller lifecycle, mcp restart, capability recovery, and Local Bridge behavior so they do not report fake restart success. Return a compact scheduled/accepted result before stopping the old Gateway when invoked inside the managed process tree; external CLI may still wait synchronously. Preserve durable Jobs/WorkContracts across restart. Verify local MCP, daemon, Local Bridge, public domain health, OAuth discovery, runtime generation/source, and connectorNeedsReconnect=false after restart. Add failure-injection and process-ownership tests. Document the exact guarantee: the in-flight MCP connection may close during a full Gateway restart, but the stable domain and durable request/work IDs must allow the same ChatGPT conversation to call again without manual Connector recreation when tool schema/auth are unchanged.
- Depends on: none
- Allowed paths: `scripts/controller-runtime.sh`, `src/cli/controller/**`, `src/cli/mcp/**`, `src/cli/local-bridge/**`, `src/runtime/recovery/**`, `src/runtime/gateway/**`, `src/runtime/control-plane/**`, `tests/cli/**`, `tests/runtime/**`, `docs/operations/**`, `docs/architecture/current/**`, `docs/repo-harness-runtime-self-healing-loop.md`, `package.json`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

### T3 — Implement restart coordinator directly

- Status: `done`
- Objective: Replace cancelled T2 after both external executors proved unavailable. Implement and verify the same authoritative out-of-band restart protocol through ChatGPT-supervised direct edits in a controller-managed isolated worktree. Reuse T2 findings and acceptance contract; do not retry the unavailable agents.
- Depends on: none
- Allowed paths: `scripts/controller-runtime.sh`, `src/cli/controller/**`, `src/cli/mcp/**`, `src/cli/local-bridge/**`, `src/runtime/recovery/**`, `src/runtime/gateway/**`, `src/runtime/control-plane/**`, `tests/cli/**`, `tests/runtime/**`, `docs/operations/**`, `docs/architecture/current/**`, `docs/repo-harness-runtime-self-healing-loop.md`, `package.json`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

## Related Artifacts

- `commit:a718911`
- `commit:43b33f4`
- `commit:15a44fc7`
- `commit:0fd5d85d`
- `commit:a96b321d`
- `commit:5d48975d`
- `execution:EJOB-1784100426999-211b1513`
- `restart:restart-after-durable-closure-merge-20260715`
