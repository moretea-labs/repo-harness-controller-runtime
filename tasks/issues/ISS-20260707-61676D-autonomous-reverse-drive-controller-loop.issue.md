---
id: "ISS-20260707-61676D"
kind: "feature"
status: "done"
updated_at: "2026-07-09T18:00:00.000Z"
source: "repo-harness-controller-v8"
---

# Autonomous reverse-drive controller loop

Make repo-harness a self-driving local assistant that can monitor work, produce continuation packets, request future ChatGPT attention through scheduled tasks or UI notifications, and fall back to local/backup model paths when ChatGPT tool calls are blocked.

## Goals

- Define ChatGPT as primary policy/controller while repo-harness owns local daemon execution, monitoring, schedules, and continuation state.
- Add reverse-drive continuation packets that summarize objective, current state, blockers, next safe tool calls, and required user action only when necessary.
- Add schedule/monitor hooks that can notify or create a future ChatGPT task/reminder instead of silently stopping.
- Move DeepSeek fallback preparation into local repo-harness so it does not depend on ChatGPT invoking DeepSeek tools.
- Classify platform-blocked operations such as restart, iOS scheme listing, check listing, and model handoff as first-class repair findings.
- Provide a safe restart/rollout path that can run locally and then instruct ChatGPT Connector rescan without using blocked tool text.

## Non-goals

- Bypass OpenAI or platform safety checks.
- Let external models execute tools directly.
- Push code or publish releases automatically.
- Use secrets without local configuration.

## Acceptance Criteria

- [x] repo-harness can generate a continuation packet for ChatGPT after any blocked or failed task.
- [x] local daemon can monitor queued/running jobs and produce actionable findings without a user prompt.
- [x] DeepSeek fallback can prepare a local packet when configured state is missing or ChatGPT handoff tools are blocked.
- [x] Restart/rescan guidance is represented as a structured local action and user-facing instruction, not a raw blocked command only.
- [x] Blocked iOS/check tools create repair findings with next safe actions.

## Implementation notes (2026-07-09)

Completed via autonomous GoalContract loop (`src/runtime/control-plane/goal-loop/`):

- Durable GoalContract + handoff packets in controller-home storage
- Daemon tick from `GlobalScheduler` (`tickGoalLoopsForController`)
- Provider registry distinguishes invokable vs `chatgpt_handoff` handoff-only
- Executor router + policy gates + repair taxonomy
- Docs: `docs/repo-harness-autonomous-goal-loop.md`

## GitHub

- Not published.

## Tasks

### T1 — Continuation packet model

- Status: `ready`
- Objective: Implement or document a durable continuation packet format for reverse-driving future ChatGPT sessions with objective, state, blockers, next tools, and escalation requirements.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T2 — Local monitor to continuation workflow

- Status: `ready`
- Objective: Connect schedule/monitor findings to continuation packets and candidate findings so repo-harness can request future attention without losing state.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T3 — DeepSeek local fallback configuration

- Status: `ready`
- Objective: Move DeepSeek prepare-only fallback packet generation into local repo-harness and add clear configuration diagnostics for missing API keys or disabled clients.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

### T4 — Blocked operation repair taxonomy

- Status: `ready`
- Objective: Classify blocked restart, app status, check listing, and backup handoff operations as first-class repair categories with safe next actions.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`
- Checks: `npm run check:type`, `bun test`
- Execution hint: agent / codex

## Related Artifacts

- None.
