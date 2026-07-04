---
id: "ISS-20260703-A94701"
kind: "investigation"
status: "in_progress"
updated_at: "2026-07-03T14:28:47.356Z"
source: "repo-harness-controller-v8"
---

# Implement generic personal assistant plugin runtime

Implement the generic plugin runtime described by T1. Use one canonical state model integrated with existing MCP, Local Controller and Execution Job layers. Include versioned manifests, registry/discovery, lifecycle/health, typed action schemas, permission scopes, risk/confirmation policies, idempotency, cancellation/timeouts, structured results and audit events. Add focused unit/integration tests, update docs, run checks, and commit.

## Goals

- Implement the generic plugin runtime described by T1. Use one canonical state model integrated with existing MCP, Local Controller and Execution Job layers. Include versioned manifests, registry/discovery, lifecycle/health, typed action schemas, permission scopes, risk/confirmation policies, idempotency, cancellation/timeouts, structured results and audit events. Add focused unit/integration tests, update docs, run checks, and commit.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] Plugin lifecycle and capability discovery work.
- [ ] Unsafe writes require policy-driven confirmation.
- [ ] Actions are idempotent and auditable.
- [ ] No duplicate state authority introduced.
- [ ] Tests and checks pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement generic personal assistant plugin runtime

- Status: `review`
- Objective: Implement the generic plugin runtime described by T1. Use one canonical state model integrated with existing MCP, Local Controller and Execution Job layers. Include versioned manifests, registry/discovery, lifecycle/health, typed action schemas, permission scopes, risk/confirmation policies, idempotency, cancellation/timeouts, structured results and audit events. Add focused unit/integration tests, update docs, run checks, and commit.
- Depends on: none
- Allowed paths: not defined
- Checks: `package:check:type`, `package:test`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
