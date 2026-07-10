---
id: "ISS-20260705-5415C5"
kind: "feature"
status: "cancelled"
updated_at: "2026-07-10T13:35:04.629Z"
archived_at: "2026-07-10T13:35:04.629Z"
source: "repo-harness-controller-v8"
---

# Self-healing capability recovery

Add a structured recovery system for repo-harness capability degradation. It must distinguish local recoverable failures from client-side platform blocks, run safe capability probes, expose explicit recovery actions, support sandbox patch handoff, and create bounded source-fix tasks when repo-harness itself has a defect.

## Goals

- Provide a capability health matrix that explains what is working, degraded, blocked, or unavailable.
- Recover local failures automatically or through explicit authorized actions.
- Prevent unsafe self-modification loops by requiring scoped worktrees, verification gates, audit records, and user acceptance for high-risk fixes.
- Give ChatGPT a reliable fallback path when direct tool calls are blocked: produce a local patch artifact or durable Issue/task that can be resumed by the controller.

## Non-goals

- Bypass OpenAI or platform-level safety checks.
- Allow unbounded writes to arbitrary local paths.
- Restart unrelated user applications without authorization.
- Silently commit code without tests or audit evidence.

## Acceptance Criteria

- [ ] A read-only recovery probe reports daemon, bridge, worker, repo registration, projection, command-preview, command-execute, issue, job, and plugin capability states.
- [ ] The probe classifies failures into local_recoverable, auth_required, policy_denied, platform_blocked, user_action_required, or unknown.
- [ ] Authorized recovery actions can restart repo-harness/local bridge, refresh repository registration, rebuild projections, reconcile stale jobs/leases, and clear abandoned worktrees without touching unrelated user files.
- [ ] Platform-side blocks are detected as non-local and produce safe fallback recommendations rather than retry loops.
- [ ] A sandbox patch handoff workflow can create an isolated worktree patch artifact with verification evidence and integrate only through existing gates.
- [ ] Tests cover degraded detection, local restart planning, stale lease cleanup, blocked direct execution fallback, patch artifact generation, and audit logging.

## GitHub

- Not published.

## Tasks

### T1 — Define recovery taxonomy and state machine

- Status: `done`
- Objective: Document the failure taxonomy, state machine, audit model, and safety boundaries for repo-harness capability recovery. Include client-side platform blocks as a non-local class that cannot be fixed by restarting local services.
- Depends on: none
- Allowed paths: `docs/**`, `src/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T2 — Implement capability probe and recovery planner

- Status: `done`
- Objective: Implement a read-only capability probe that returns a matrix of capability states, classified failure reasons, suggested recovery actions, and fallback paths without modifying repositories by default.
- Depends on: `T1`
- Allowed paths: `src/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T3 — Implement authorized local recovery actions

- Status: `done`
- Objective: Implement explicit bounded recovery actions for local failures: restart controller daemon or local bridge, refresh registration, rebuild runtime projections, reconcile stale jobs and leases, and clean abandoned worktrees. Mutating actions must require authorization and write audit evidence.
- Depends on: `T2`
- Allowed paths: `src/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T4 — Implement sandbox patch handoff workflow

- Status: `done`
- Objective: Implement a fallback workflow where blocked ChatGPT sessions can create or resume a local agent task that produces a patch artifact in an isolated worktree, runs verification, and integrates only through existing review and acceptance gates.
- Depends on: `T2`
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T5 — Verify recovery system end to end

- Status: `ready`
- Objective: Add targeted regression tests and run type checks for the recovery probe, recovery actions, platform-block fallback, stale job cleanup, and sandbox patch flow. Prepare a concise operator runbook.
- Depends on: `T2`, `T3`, `T4`
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`, `package:test`
- Execution hint: agent / codex

## Related Artifacts

- None.
