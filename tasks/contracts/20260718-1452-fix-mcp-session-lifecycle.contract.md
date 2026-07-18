# Task Contract: fix-mcp-session-lifecycle

> **Status**: Active
> **Plan**: plans/plan-20260718-1452-fix-mcp-session-lifecycle.md
> **Task Profile**: code-change
> **Owner**: greyson
> **Capability ID**: root
> **Last Updated**: 2026-07-18 14:53
> **Review File**: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`
> **Notes File**: `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`

## Goal

Eliminate recurring MCP 502/503 failures caused by leaked Streamable HTTP sessions, false readiness, and stable-ingress event-loop coupling.

## Scope

- In scope: unified MCP session lifecycle, deterministic reclamation, DELETE support, capacity-aware readiness, Supervisor recovery decisions, isolated stable ingress, regression coverage, and architecture/operations synchronization.
- Out of scope: editing `_ops/*`, rotating credentials, changing Cloudflare configuration, or rolling the branch into the currently running production service without a separate deployment decision.

## Workflow Inventory

- Source plan: `plans/plan-20260718-1452-fix-mcp-session-lifecycle.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`
- Notes file: `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: `scripts/verify-sprint.sh` must see this contract pass, the review recommend pass, and `## External Acceptance Advice` pass or record a manual override.

## Allowed Paths

```yaml
allowed_paths:
  - .gitignore
  - docs/spec.md
  - docs/architecture/
  - docs/operations/controller-performance-and-502.md
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md
  - tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md
  - tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md
  - .ai/context/capabilities.json
  - .claude/templates/
  - src/
  - tests/
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    tool_calls: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md
  tests_pass:
    - path: tests/unit/fix-mcp-session-lifecycle.test.ts
  commands_succeed:
    - bunx tsc --noEmit
    - bun test
  qa_scores:
    - dimension: functionality
      min: 7
  manual_checks:
    - "Evaluator review file recommends pass"
```

## Acceptance Notes (Human Review)

- Functional behavior: stale stream-only sessions are reclaimed and reconnect succeeds without monotonically increasing overload failures.
- Edge cases: active POST work remains protected; three MCP routes share one capacity pool; client DELETE closes the SDK transport; isolated ingress survives long-lived streams without sharing the Supervisor event loop.
- Regression risks: session rotation closes long-lived SSE streams by design, so clients must honor reconnect; rollout must install the new immutable Supervisor release before live behavior changes.

## Rollback Point

- Commit / checkpoint: pre-fix baseline `6212e4e1a7c7b07db5c7bf247426da3d0feaf7cb`.
- Revert strategy: revert the isolated branch or reinstall the prior immutable Supervisor release; no `_ops` data migration is required.
