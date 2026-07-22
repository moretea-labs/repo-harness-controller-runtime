# Direct Edit Completion Receipts

## Decision

Task completion is now keyed by a unified completion receipt instead of requiring every completed Task to carry Agent Run evidence.

## Rationale

- Direct Edit sessions can own a complete delivery lifecycle without creating an Agent Run.
- Completion must prove the target revision is reachable from the target branch, task checks and acceptance evidence passed, and task-owned changes are integrated.
- Cleanup failures for already-delivered temporary worktrees, branches, or edit-session backups are maintenance warnings unless they imply unintegrated changes, live writers, or unknown ownership.

## Compatibility

Legacy Run-backed integration and cleanup evidence remains accepted. Historical done Tasks may be reconciled only when their verification still passes and an explicit integrated revision is reachable from the target branch.

## Hardening follow-up

The completion path must revalidate finalized session ownership, bind each receipt to its exact Issue/Task and integration target, roll back discarded active edits, and derive blockers from legacy cleanup booleans rather than trusting absent blocker arrays.

## Performance / stability follow-up

- Default MCP/job responses use compact budgets (success <16KB, failure <32KB) and avoid nesting full repository/runtimeStorage/routing dumps.
- evidenceId (EVD-...) and artifactId (ART-...) are distinct; get_artifact rejects ID confusion with explicit next steps.
- Short readonly repository commands stay on Process Runtime Direct; mutations keep durable jobId/localJob settlement.
- package:check:controller-v8 is self-hosting: run_check rejects it with a clear error; heavy-check exclusive claims are not taken for nested self-host suites.
- Integration target branch resolution caches registry lookups with mtime + 30s TTL invalidation.
- Idempotent transport helpers may retry 502/503/429 once-to-thrice; mutations never retry without an idempotency key.
