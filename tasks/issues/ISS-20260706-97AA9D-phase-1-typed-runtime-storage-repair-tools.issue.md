---
id: "ISS-20260706-97AA9D"
kind: "feature"
status: "done"
updated_at: "2026-07-08T03:50:34.000Z"
source: "repo-harness-controller-v8"
---

# Phase 1 typed runtime storage repair tools

Implement typed runtime storage/local-jobs repair preview and apply actions for repo-harness self-healing. This phase is scoped only to repo-harness-controller-runtime and must not touch yaozhunshi or other repositories.

## Goals

- Expose runtime storage repair preview/apply actions with repoId scoping.
- Repair preview should inspect repository local-jobs and controller-home local-jobs without mutation.
- Repair apply should only handle explicit safe candidates by default.
- Retain bootstrap script as fallback while moving normal self-healing into typed tools.
- Add regression tests and MCP compatibility updates.

## Non-goals

- Operations on yaozhunshi or any other repository.
- Cross-repository cleanup or worker termination.
- Deleting legacy runs.
- Unreviewed merge, push, or release.
- iOS simulator tooling in this phase.

## Acceptance Criteria

- [ ] Preview reports stale, missing, unreadable, pending, and active local-job candidates without mutation.
- [ ] Apply terminalizes or quarantines only safe repo-scoped local-job candidates by default.
- [ ] Pending approvals require explicit authorization to cancel.
- [ ] No process kill is performed by default.
- [ ] Audit evidence records inspected roots and applied actions.
- [ ] Tests validate stale, missing, unreadable, pending, and cross-repo exclusion cases.
- [ ] npm run check:type and npm run check:mcp-compatibility pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement typed runtime storage repair

- Status: `cancelled`
- Objective: Add runtime storage/local-jobs repair preview and apply actions, wire them into MCP runtime tools, update compatibility checks, and add focused tests and docs. Preserve repository scoping and yaozhunshi exclusion.
- Depends on: none
- Allowed paths: `src/runtime/recovery/**`, `src/runtime/gateway/mcp/**`, `tests/runtime/**`, `scripts/check-mcp-compatibility.ts`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`
- Execution hint: agent / codex

### T2 — Validate typed runtime storage repair tools

- Status: `done`
- Objective: Validate the already available runtime_storage_repair_preview and runtime_storage_repair_apply MCP tools, record targeted verification evidence, and close the Phase 1 runtime storage repair work without expanding scope.
- Depends on: none
- Allowed paths: `src/runtime/recovery/**`, `src/runtime/gateway/mcp/**`, `tests/runtime/**`, `scripts/check-mcp-compatibility.ts`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`
- Execution hint: selected at runtime

## Related Artifacts

- None.
