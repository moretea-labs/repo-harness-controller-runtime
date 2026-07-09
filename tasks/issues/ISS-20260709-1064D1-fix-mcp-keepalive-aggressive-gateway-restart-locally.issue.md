---
id: "ISS-20260709-1064D1"
kind: "bug"
status: "planned"
updated_at: "2026-07-08T23:58:43.655Z"
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

- Status: `blocked`
- Objective: Inspect and update MCP keepalive restart policy so short health failures do not kill live Gateway sessions, process exit still restarts immediately, and sustained unhealthiness beyond the configured safety window restarts safely. Change only the keepalive implementation and targeted tests.
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `tests/cli/mcp-keepalive.test.ts`
- Checks: `package:check:type`
- Execution hint: agent / claude

## Related Artifacts

- None.
