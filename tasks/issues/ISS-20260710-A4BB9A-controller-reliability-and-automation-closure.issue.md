---
id: "ISS-20260710-A4BB9A"
kind: "governance"
status: "done"
updated_at: "2026-07-10T02:22:29.209Z"
archived_at: "2026-07-10T02:22:29.209Z"
source: "repo-harness-controller-v8"
---

# Controller reliability and automation closure

Closed the gap between process readiness and trustworthy automation reporting, added reliability operations guidance, fixed bounded job summary behavior, integrated managed Google runtime credentials and Local Bridge reliability changes, and verified the committed controller surface.

## Goals

- Make automation status distinguish shadow observations from live maintenance/execution.
- Surface degraded execution readiness separately from process-level readiness.
- Improve resource and stale runtime cleanup guidance for multi-repository operation.
- Keep the repository clean and verify targeted controller checks.

## Non-goals

- No broad test expansion.
- No unrelated GUI redesign.
- No destructive cleanup without explicit safe preview.

## Acceptance Criteria

- [ ] Controller readiness or docs clearly distinguish runtime readiness, delivery readiness, and automation readiness.
- [ ] Shadow schedules and maintenance schedules are documented or configured so users understand what actually runs.
- [ ] Resource diagnostics for high-CPU peer MCP processes and stale temp entries are actionable.
- [ ] Targeted checks pass and worktree is clean after commit.

## GitHub

- Not published.

## Tasks

### T1 — Harden automation readiness reporting

- Status: `superseded`
- Objective: Inspect schedule/readiness code and update user-facing reporting or documentation so shadow schedules are not mistaken for active autonomous execution.
- Depends on: none
- Allowed paths: `src/`, `docs/`, `README.md`, `tasks/`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T2 — Document reliability operations runbook

- Status: `done`
- Objective: Add or update docs for runtime maintenance, projection rebuild, high-CPU peer MCP handling, plugin degraded states, and board governance cleanup.
- Depends on: none
- Allowed paths: `docs/`, `README.md`, `tasks/`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T3 — Add automation readiness regression coverage

- Status: `done`
- Objective: Cover shadow-only readiness and conditional live dispatch wording without expanding the broader test suite.
- Depends on: none
- Allowed paths: `tests/`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T4 — Close manually integrated automation readiness work

- Status: `done`
- Objective: Record verification and acceptance for the already-reviewed readiness changes after the original Run remained waiting_for_user following a failed automatic integration precondition.
- Depends on: none
- Allowed paths: `src/`, `docs/`, `README.md`, `tests/`, `tasks/`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
