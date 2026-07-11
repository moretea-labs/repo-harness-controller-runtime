---
id: "ISS-20260711-A0CDA5"
kind: "feature"
status: "done"
updated_at: "2026-07-11T05:04:55.150Z"
archived_at: "2026-07-11T05:04:55.150Z"
source: "repo-harness-controller-v8"
---

# Implement Request and Full Access permission model with minimal connector tool exposure

Completed through direct edits and reconciliation on main. Request / Full Access repository policy, controllerHome persistence, Work permission snapshots, minimal core exposure with always-available access controls, GUI selector, high-risk safeguards, runtime cleanup, compatibility validation, and final GUI script fixes are integrated and pushed at 635d476. Historical T1 remains cancelled because the optional agent run failed before producing changes; T2 is the authoritative completed replacement.

## Goals

- Default connector tools/list exposes only the small facade surface required for normal ChatGPT operation.
- Request and Full Access modes are persisted under controllerHome.
- Each Work captures an immutable effective permission snapshot at start.
- Controller GUI shows the active mode, effective state, and allows safe switching.
- High-risk, destructive, remote-write, and secret-sensitive actions retain explicit confirmation/approval fallback regardless of mode.
- Add focused tests and documentation without broad test expansion.
- Commit changes on an isolated feature branch, merge into main safely, delete the feature branch, and clean its worktree.

## Non-goals

- Do not remove internal advanced tools from the server implementation; restrict connector exposure/discovery instead.
- Do not weaken existing destructive, remote-write, secret, or policy gates.
- Do not rewrite unrelated GUI/runtime architecture.
- Do not modify or discard pre-existing dirty main working-tree changes.

## Acceptance Criteria

- [ ] A fresh connector tools/list contains the intended minimal facade set by default, with an explicit advanced/full-access mechanism rather than the full legacy surface.
- [ ] Request and Full Access settings survive controller restart via controllerHome storage.
- [ ] Started Work records include the resolved mode and capability/approval snapshot used for execution.
- [ ] GUI displays and switches access mode with clear pending/effective state.
- [ ] Existing high-risk approval behavior remains covered by focused tests.
- [ ] Targeted type/tests pass and diff is reviewed.
- [ ] Feature commit is merged into main without disturbing pre-existing main working-tree changes; feature branch/worktree are removed.

## GitHub

- Not published.

## Tasks

### T1 — Implement permission model and minimal connector exposure

- Status: `cancelled`
- Objective: Inspect the MCP tool registration/list path, controllerHome runtime configuration, Work creation, policy gates, and local controller GUI. Implement Request / Full Access persistence and snapshots, default minimal tool exposure, GUI switching/status, compatibility and focused tests/docs. Work only in an isolated worktree and preserve existing high-risk approvals.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`, `README.md`, `README.en.md`, `README.zh-CN.md`, `package.json`, `scripts/**`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:mcp-compatibility`, `package:test:bun`
- Execution hint: agent / codex

### T2 — Verify direct-edit access-mode integration

- Status: `done`
- Objective: Record and verify the direct-edit implementation and reconciliation on main after the optional agent run failed without changes.
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `docs/**`, `README.md`, `README.en.md`, `README.zh-CN.md`, `scripts/**`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:mcp-compatibility`
- Execution hint: selected at runtime

## Related Artifacts

- `635d476c4600907a7e2c0395293370dd1855dd81`
