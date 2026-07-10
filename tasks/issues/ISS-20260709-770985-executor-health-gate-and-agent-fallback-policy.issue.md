---
id: "ISS-20260709-770985"
kind: "feature"
status: "done"
updated_at: "2026-07-10T12:25:26.177Z"
archived_at: "2026-07-10T12:25:26.177Z"
source: "repo-harness-controller-v8"
---

# Executor health gate and agent fallback policy

Executor health gate and fallback policy completed. Commit b2714d0 added structured executor health classification and dispatch fallback behavior; commit 9b1e5f6 fixed follow-up MCP controllerHome test typing so package:check:type passes. Cloudflare fixed-domain MCP endpoint support is tracked separately in commit 6a83b23.

## Goals

- Expose structured executor health for Codex, Claude, GitHub Copilot/CCA, and MCP connector reachability where currently available.
- Before dispatch_task, launch_issue, or submit_local_job starts an agent, detect known unavailable executor states such as CCA disabled, local agent disabled, authentication required, usage limit, and insufficient balance.
- Return actionable fallback recommendations: direct edit for small scoped tasks, available alternate executor if any, or exact operator remediation when all executors are unavailable.
- Record compact, bounded diagnostics without leaking secrets or huge stdout/stderr.
- Prefer targeted checks and avoid test expansion.

## Non-goals

- Do not implement Cloudflare fixed domain or ngrok fallback in this issue.
- Do not change MCP protocol semantics.
- Do not change worker queue/lease behavior except dispatch preflight classification.
- Do not enable or store user API keys.
- Do not expand broad test suites unnecessarily.

## Acceptance Criteria

- [ ] Executor availability can be inspected before launching an agent.
- [ ] Known unavailable executor failures are classified with stable reason codes.
- [ ] Dispatch paths fail fast with a clear message instead of launching doomed runs for disabled/unfunded/unauthorized executors.
- [ ] For small scoped tasks, fallback guidance recommends direct edit rather than retrying unavailable agents.
- [ ] Type check and focused tests pass or any unrelated failures are documented.

## GitHub

- Not published.

## Tasks

### T1 — Map executor launch and failure paths

- Status: `done`
- Objective: Inspect current dispatch_task, launch_issue, submit_local_job, local agent configuration, GitHub Copilot cloud launch, and run failure classification paths. Identify the smallest source locations for executor health and fallback policy.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T2 — Implement executor health gate

- Status: `done`
- Objective: Add structured executor health/preflight classification used before agent launch. It should report available, disabled, auth_required, quota_or_balance, cloud_not_enabled, unknown, and include compact remediation guidance without exposing secrets.
- Depends on: `T1`
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — Wire fallback policy into dispatch

- Status: `done`
- Objective: Use executor health/preflight before dispatch_task, launch_issue, and submit_local_job start an agent. Fail fast for known unavailable executors and return fallback recommendations, especially direct edit for small scoped tasks.
- Depends on: `T2`
- Allowed paths: `src/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T4 — Add focused tests and operator docs

- Status: `done`
- Objective: Add targeted tests and concise docs/runbook for executor health, fallback policy, and remediation commands. Do not document Cloudflare fixed-domain work here except as a deferred separate item.
- Depends on: `T3`
- Allowed paths: `tests/**`, `docs/**`, `README.md`
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- None.
