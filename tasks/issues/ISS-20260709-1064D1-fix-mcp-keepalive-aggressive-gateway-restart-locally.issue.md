---
id: "ISS-20260709-1064D1"
kind: "bug"
status: "done"
updated_at: "2026-07-10T11:43:58.863Z"
archived_at: "2026-07-10T11:43:58.863Z"
source: "repo-harness-controller-v8"
---

# Fix MCP keepalive aggressive gateway restart locally

GitHub Copilot cloud execution for ISS-20260626-A674DE/T10 failed because Copilot Coding Agent is not enabled for the user or repository. Create a local fallback task to fix the same MCP keepalive aggressive restart behavior using a local executor, limited to the intended keepalive source and tests.

## Goals

- Prevent transient /health failures from restarting an otherwise live MCP Gateway.
- Restart immediately when the Gateway process has actually exited.
- Only restart a still-running Gateway after a sustained outage window around five minutes.
- Preserve existing Tailscale/Funnel and controllerHome-backed MCP config behavior.

## Non-goals

- Do not change worker runtime, queue, lease, GUI, or repository registry behavior.
- Do not remove Tailscale Funnel support.
- Do not merge automatically without review.

## Acceptance Criteria

- [ ] Transient health check failures mark the Gateway degraded but do not restart a live Gateway.
- [ ] Exited Gateway process still triggers immediate restart.
- [ ] Sustained health loss beyond the safety window can restart a still-running Gateway.
- [ ] Targeted keepalive tests and package type check pass or failures are clearly reported.

## GitHub

- Not published.

## Tasks

### T1 — Fix keepalive restart policy

- Status: `superseded`
- Objective: Inspect and update MCP keepalive restart policy so short health failures do not kill live Gateway sessions, process exit still restarts immediately, and sustained unhealthiness beyond the configured safety window restarts safely. Change only the keepalive implementation and targeted tests.
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `tests/cli/mcp-keepalive.test.ts`
- Checks: `package:check:type`
- Execution hint: agent / claude
- Superseded by: `T4`

### T2 — Implement bounded Gateway keepalive and supervisor-safe restart

- Status: `superseded`
- Objective: Replace the failed zero-output keepalive attempt. Inspect and update MCP keepalive/restart lifecycle so transient health failures mark degraded and preserve a live Gateway, process exit restarts immediately, and a still-live but unhealthy Gateway restarts only after a configurable sustained-failure threshold. Ensure restart is supervisor-safe/asynchronous so the caller is not synchronously killing its own control path. Add focused regression tests, run targeted checks and typecheck, commit in an isolated branch, do not push.
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `src/cli/mcp/restart.ts`, `src/cli/mcp/setup.ts`, `src/cli/mcp/transports/http.ts`, `tests/cli/**`, `docs/operations/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T3 — Implement precise keepalive degradation and restart policy

- Status: `superseded`
- Objective: Replace the scope-conflicting T2 launch attempt. Modify only keepalive/restart implementation and the two dedicated lifecycle tests. Transient health failures mark degraded without restarting a live Gateway; process exit restarts immediately; a still-live unhealthy Gateway restarts only after a configurable sustained-failure threshold. Restart initiation must be supervisor-safe and not depend on the caller surviving. Run focused tests and typecheck, commit in an isolated branch, do not push.
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `src/cli/mcp/restart.ts`, `tests/cli/mcp-keepalive.test.ts`, `tests/cli/mcp-restart-process-ownership.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T4`

### T4 — Close verified keepalive recovery work

- Status: `done`
- Objective: Record manual review, main integration, regression evidence, and clean branch/worktree closure for the keepalive restart policy implementation.
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `src/cli/mcp/restart.ts`, `tests/cli/mcp-keepalive.test.ts`, `tests/cli/mcp-restart-process-ownership.test.ts`
- Checks: `package:check:controller-v8`, `package:check:release-readiness`
- Execution hint: agent / codex

## Related Artifacts

- None.
