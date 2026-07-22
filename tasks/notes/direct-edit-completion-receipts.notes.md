# Direct Edit Completion Receipts

## Decision

Task completion is now keyed by a unified completion receipt instead of requiring every completed Task to carry Agent Run evidence.

## Rationale

- Direct Edit sessions can own a complete delivery lifecycle without creating an Agent Run.
- Completion must prove the target revision is reachable from the target branch, task checks and acceptance evidence passed, and task-owned changes are integrated.
- Cleanup failures for already-delivered temporary worktrees, branches, or edit-session backups are maintenance warnings unless they imply unintegrated changes, live writers, or unknown ownership.

## Compatibility

Legacy Run-backed integration and cleanup evidence remains accepted. Historical done Tasks may be reconciled only when their verification still passes and an explicit integrated revision is reachable from the target branch.
