---
id: "ISS-20260707-5BC04A"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-07T01:08:49.048Z"
source: "repo-harness-controller-v8"
---

# Multi-model MCP host controllers

Allow repo-harness to support DeepSeek and future models as MCP-host-style controllers, not only API-key fallback adapters. ChatGPT should not be the only primary controller; repo-harness should expose a policy-gated tool surface to multiple controller clients.

## Goals

- Define a model-controller abstraction where ChatGPT, DeepSeek, Codex CLI, Claude, and future models can act as primary or backup controllers.
- Support DeepSeek as an MCP-host-style controller path where it can discover tools, select calls, and drive work through repo-harness policy gates.
- Keep repo-harness as the execution authority: all controller clients must go through leases, budgets, confirmations, audit, and bounded tool schemas.
- Separate model transport from control role: MCP host, CLI controller, API function-calling, and local GUI should all map into the same ControllerClient contract.
- Make scheduling able to choose an available controller without user intervention according to policy and risk.

## Non-goals

- Let any model bypass repo-harness policy.
- Hard-code DeepSeek as the only non-ChatGPT controller.
- Store model API keys in tracked files.
- Require human notification for ordinary safe continuation.

## Acceptance Criteria

- [ ] Architecture docs distinguish MCP-host-style controller clients from API/function-calling adapters.
- [ ] DeepSeek has a planned MCP-host-compatible control path, even if implemented via local bridge/proxy when native MCP host support is unavailable.
- [ ] Controller selection policy can choose ChatGPT, DeepSeek, Codex CLI, or local GUI based on availability, configuration, risk, and budget.
- [ ] All tool calls from non-ChatGPT controllers are normalized into the same audited repo-harness operation pipeline.
- [ ] Tests cover controller registration, tool-surface discovery, policy gating, and fallback selection.

## GitHub

- Not published.

## Tasks

### T1 — Controller client abstraction

- Status: `review`
- Objective: Define a ControllerClient contract for ChatGPT MCP, DeepSeek MCP-host-style control, CLI controllers, API function-calling adapters, and local GUI. Include roles, transports, capabilities, and policy boundaries.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T2 — DeepSeek MCP host design

- Status: `ready`
- Objective: Design and implement the first bounded DeepSeek MCP-host-style path or local MCP proxy plan so DeepSeek can discover and select repo-harness tools instead of being only an API-key fallback.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T3 — Controller selection policy

- Status: `ready`
- Objective: Add scheduling/monitor policy that selects an available controller client for safe continuation before escalating to human notification.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T4 — Normalize non-ChatGPT tool calls

- Status: `ready`
- Objective: Normalize tool calls from DeepSeek, CLI, and future controllers into audited repo-harness operations with the same policy gates as ChatGPT MCP.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

## Related Artifacts

- None.
