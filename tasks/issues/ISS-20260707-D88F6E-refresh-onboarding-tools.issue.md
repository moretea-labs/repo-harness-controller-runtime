---
id: "ISS-20260707-D88F6E"
kind: "investigation"
status: "in_progress"
updated_at: "2026-07-07T00:18:42.152Z"
source: "repo-harness-controller-v8"
---

# Refresh onboarding tools

Refresh or document the minimal controller restart/rollout path needed so newly added repository_latest_source_diagnose and repository_bootstrap_local_project MCP tools become available to ChatGPT. Do not mutate external user projects. Prefer local repo-harness rollout/restart if safe; otherwise add exact bounded recovery instructions and tests.

## Goals

- Refresh or document the minimal controller restart/rollout path needed so newly added repository_latest_source_diagnose and repository_bootstrap_local_project MCP tools become available to ChatGPT. Do not mutate external user projects. Prefer local repo-harness rollout/restart if safe; otherwise add exact bounded recovery instructions and tests.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] Complete: Refresh or document the minimal controller restart/rollout path needed so newly added repository_latest_source_diagnose and repository_bootstrap_local_project MCP tools become available to ChatGPT. Do not mutate external user projects. Prefer local repo-harness rollout/restart if safe; otherwise add exact bounded recovery instructions and tests.

## GitHub

- Not published.

## Tasks

### T1 — Refresh onboarding tools

- Status: `review`
- Objective: Refresh or document the minimal controller restart/rollout path needed so newly added repository_latest_source_diagnose and repository_bootstrap_local_project MCP tools become available to ChatGPT. Do not mutate external user projects. Prefer local repo-harness rollout/restart if safe; otherwise add exact bounded recovery instructions and tests.
- Depends on: none
- Allowed paths: `src`, `tests`, `docs`, `plans`, `.ai/harness`
- Checks: `npm run check:type`, `bun test tests/cli/repository-local-project-onboarding.test.ts tests/cli/repository-mcp-command.test.ts`
- Execution hint: agent / codex

## Related Artifacts

- None.
