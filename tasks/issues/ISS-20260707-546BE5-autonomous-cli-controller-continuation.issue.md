---
id: "ISS-20260707-546BE5"
kind: "feature"
status: "in_progress"
updated_at: "2026-07-10T11:41:54.153Z"
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

### T5 — Implement one bounded live autonomous maintenance loop

- Status: `ready`
- Objective: Implement and verify one real live Schedule/Occurrence execution path for safe repo-harness runtime maintenance, instead of shadow-only readiness. The loop must be daemon-owned and bounded by daily runtime budget, cooldown, exponential backoff, maximum consecutive failures, explicit stop conditions and low-risk operation allowlist. Health/readiness/preview reads must never dispatch work. A failed or blocked occurrence must create a bounded Inbox/Handoff item and stop according to policy rather than repeatedly executing. Add focused tests and concise operator documentation, commit in an isolated branch, do not push.
- Depends on: none
- Allowed paths: `src/runtime/control-plane/schedules/**`, `src/runtime/control-plane/goal-loop/**schedule**`, `src/runtime/control-plane/goal-loop/**occurrence**`, `src/runtime/control-plane/**maintenance**`, `src/cli/controller/**schedule**`, `src/cli/local-bridge/facade-api.ts`, `tests/runtime/**schedule**`, `tests/runtime/**occurrence**`, `tests/cli/**schedule**`, `docs/operations/**`, `docs/repo-harness-autonomous-goal-loop.md`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T6 — Implement precise bounded live maintenance occurrence

- Status: `superseded`
- Objective: Replace the scope-conflicting T5 dispatch attempt. Implement one real live low-risk maintenance Schedule/Occurrence path only in the schedule engine/store/settlement and maintenance executor. Enforce daily runtime budget, cooldown, exponential backoff, maximum consecutive failures, explicit stop conditions and an operation allowlist. Readiness and preview remain side-effect free. A failed or blocked occurrence writes one bounded handoff/inbox-compatible record and stops according to policy. Add dedicated schedule tests, run typecheck and focused checks, commit in an isolated branch, do not push.
- Depends on: none
- Allowed paths: `src/runtime/workflow/schedules/engine.ts`, `src/runtime/workflow/schedules/types.ts`, `src/runtime/workflow/schedules/settlement.ts`, `src/runtime/workflow/schedules/store.ts`, `src/runtime/recovery/maintenance-executor.ts`, `tests/runtime/schedule-dedupe.test.ts`, `tests/runtime/live-maintenance-schedule.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex
- Superseded by: `T7`

### T7 — Close verified bounded live maintenance work

- Status: `done`
- Objective: Record reviewed main integration and verification for the allowlisted live maintenance schedule path, budgets, backoff, stop conditions, and handoff behavior.
- Depends on: none
- Allowed paths: `src/runtime/workflow/schedules/**`, `src/runtime/recovery/maintenance-executor.ts`, `tests/runtime/live-maintenance-schedule.test.ts`, `tests/runtime/schedule-dedupe.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:release-readiness`
- Execution hint: agent / codex

## Related Artifacts

- None.
