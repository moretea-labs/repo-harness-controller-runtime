---
id: "ISS-20260719-8A4B9C"
kind: "bug"
status: "planned"
updated_at: "2026-07-19T04:30:30.713Z"
source: "repo-harness-controller-v8"
---

# Keep blue-green rollout under one global Supervisor

Fix controller rollout so candidate slots never start a second Stable Supervisor on the global ingress/rescue ports. Candidate slots must use slot-local lifecycle, while immutable release installation and activation remain owned by the root Controller Home.

## Goals

- Candidate slot startup must not bind the root Supervisor rescue/control port.
- A stale or preinstalled candidate Supervisor release must not change candidate lifecycle ownership.
- A verified rollout must install the immutable release at root Controller Home and schedule detached activation after cutover.
- Rollout failure must leave active authority and root Supervisor untouched.
- Rollback and candidate cleanup must use slot-local lifecycle.

## Non-goals

- Do not redesign stable ingress routing.
- Do not remove blue/green slot homes.
- Do not kill the active global Supervisor to free a port.
- Do not change unrelated restart coordinator behavior.

## Acceptance Criteria

- [ ] Only one global Stable Supervisor process exists during candidate startup and cutover.
- [ ] Candidate startup succeeds even when candidateHome contains an installed Supervisor release.
- [ ] Failed candidate verification preserves active slot authority and active Supervisor PID.
- [ ] Successful rollout reports root release installation and detached activation metadata.
- [ ] Targeted blue/green, type, architecture, MCP compatibility, and Controller V8 checks pass.

## GitHub

- Not published.

## Tasks

### T1 — Enforce single-Supervisor blue-green lifecycle

- Status: `ready`
- Objective: Add an internal slot-local lifecycle mode to Controller service start/stop so blue-green candidate and rollback paths bypass installed Stable Supervisor artifacts. Remove candidate-home Supervisor installation. After candidate verification, install the immutable release only in root Controller Home; after successful cutover verification, schedule detached root Supervisor activation and return its metadata. Add regression coverage for preinstalled candidate release and no second global Supervisor. Validate and merge to main, then clean branch/worktree.
- Depends on: none
- Allowed paths: `src/cli/controller/lifecycle.ts`, `src/cli/controller/bluegreen-rollout.ts`, `src/cli/commands/supervisor.ts`, `tests/cli/controller-bluegreen-isolated.test.ts`, `tests/cli/controller-service.test.ts`, `tests/runtime/stable-supervisor-hardening.test.ts`, `docs/architecture/current/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
