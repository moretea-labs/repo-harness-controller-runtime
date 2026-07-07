---
id: "ISS-20260707-546BE5"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-07T00:52:20.417Z"
source: "repo-harness-controller-v8"
---

# Autonomous CLI controller continuation

Allow repo-harness daemon to continue work with local Codex/ChatGPT-compatible CLI controllers from durable continuation packets, reducing user intervention while keeping repo-harness as policy and audit authority.

## Goals

- Support a durable continuation packet that can be consumed by a local CLI controller process such as Codex CLI or future ChatGPT CLI.
- Add a daemon-owned controller-runner that can start a bounded CLI continuation when schedules or monitors produce safe next actions.
- Keep all execution behind repo-harness policy, leases, budgets, stop conditions, and audit logs.
- Support DeepSeek as a function-calling backup reviewer through local configuration rather than assuming it is an MCP host.
- Avoid notification-only workflows except as escalation when local autonomous continuation cannot proceed.

## Non-goals

- Bypass platform safety checks.
- Let external models execute repo-harness tools directly without policy validation.
- Depend on ChatGPT initiating a new conversation.
- Store API keys in tracked repository files.

## Acceptance Criteria

- [ ] repo-harness can write a continuation packet after blocked or incomplete work.
- [ ] local daemon can launch a bounded Codex CLI continuation from the packet when configured and allowed.
- [ ] DeepSeek configuration status clearly distinguishes MCP-host support from API/function-calling adapter support.
- [ ] Blocked restart/tool-schema refresh paths become structured repair actions or continuation packet entries.
- [ ] A schedule can choose local CLI continuation before human notification when risk and policy allow.

## GitHub

- Not published.

## Tasks

### T1 — Continuation packet schema

- Status: `review`
- Objective: Define and implement a durable continuation packet schema with objective, state summary, blockers, next safe actions, allowed tools, budget, and stop conditions.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T2 — CLI continuation runner

- Status: `ready`
- Objective: Add daemon/local-job support for launching a bounded Codex CLI or ChatGPT-compatible CLI continuation from a packet, with repo-harness policy as the authority.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T3 — DeepSeek adapter docs and config

- Status: `ready`
- Objective: Document and validate DeepSeek as API/function-calling adapter rather than MCP host, with local config diagnostics and prepare-only default.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T4 — Autonomous schedule policy

- Status: `ready`
- Objective: Teach schedules/monitors to prefer local CLI continuation for safe work, then backup model review, then human notification only as escalation.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

## Related Artifacts

- None.
