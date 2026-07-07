---
id: "ISS-20260703-AC7997"
kind: "investigation"
status: "in_progress"
updated_at: "2026-07-07T08:40:22.556Z"
source: "repo-harness-controller-v8"
---

# Implement Gmail Calendar and Tasks assistant plugins

Build production-shaped Gmail, Google Calendar and Google Tasks/reminder plugins on the generic runtime. Reuse connector/auth abstractions and never persist credentials. Separate read/write scopes; gate send/delete/reschedule and other consequential writes. Add mock providers, contract tests, structured auth/rate-limit/error handling, configuration docs, run checks, and commit.

## Goals

- Build production-shaped Gmail, Google Calendar and Google Tasks/reminder plugins on the generic runtime. Reuse connector/auth abstractions and never persist credentials. Separate read/write scopes; gate send/delete/reschedule and other consequential writes. Add mock providers, contract tests, structured auth/rate-limit/error handling, configuration docs, run checks, and commit.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] All three plugins expose usable capability schemas.
- [ ] Read/write permissions are separated.
- [ ] Consequential writes require confirmation.
- [ ] Auth and provider failures are structured.
- [ ] Contract tests pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement Gmail Calendar and Tasks assistant plugins

- Status: `changes_requested`
- Objective: Build production-shaped Gmail, Google Calendar and Google Tasks/reminder plugins on the generic runtime. Reuse connector/auth abstractions and never persist credentials. Separate read/write scopes; gate send/delete/reschedule and other consequential writes. Add mock providers, contract tests, structured auth/rate-limit/error handling, configuration docs, run checks, and commit.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`, `package:test`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `docs/personal-assistant-google-plugins.md`
- `docs/architecture/current/personal-assistant-plugin-baseline.md`
- `tests/runtime/personal-assistant-plugin-runtime.test.ts`
- `tests/cli/mcp-controller.test.ts`
