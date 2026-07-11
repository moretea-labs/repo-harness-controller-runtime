# Session-aware execution architecture note

## Decision

- Session state is owned by a new Controller Home-backed `ExecutionSessionStore` in the runtime control-plane layer. The MCP transport supplies a controller-issued session identity and an authenticated/controller-issued principal; the persisted record is the source of truth after process restart.
- Work-handle state is owned by a new `WorkHandleStore`, also under Controller Home. A work handle binds repository, checkout, worktree, branch, base/expected revisions, permission snapshot, and lifecycle stages to the existing `WorkContract.workId`. It is an execution binding and does not replace Issue, Task, Run, Edit Session, Job, or WorkContract lifecycles.
- A new persistent entity is required because the existing WorkContract intentionally models intent/acceptance and does not safely own mutable checkout/worktree binding or authorization freshness. The handle reuses the WorkContract identifier where available and links to the existing contract rather than creating a competing work identity.
- Stale state is invalidated by controller-instance changes, principal mismatch, explicit repository switching, missing/deleted checkout or worktree, repository identity drift, branch/HEAD drift, WorkContract mismatch, and a monotonically versioned repository permission snapshot. Validation is centralized behind `none`, `cheap`, and `full` levels; high-risk operations always use `full`.
- Compatibility is preserved by leaving the legacy stateless resolver and all atomic tools in place. New session/work composite tools use the fast path when a valid controller-issued session or work handle is present; legacy calls without those fields continue through the existing repository/checkout resolution and durable-job adapters.

## Safety and recovery boundaries

- Session metadata may be restored only when its controller instance and principal still match; otherwise it is explicitly invalidated and cannot silently execute against a new context.
- Work handles are persisted atomically, protected by existing repository/worktree locks, and become unusable after cleanup or failed validation. Permission mode semantics remain unchanged; the new revision only detects stale snapshots.
- Large composite results use controllerHome-backed, session/work-scoped result references. Timing records are append-only controller audit evidence and do not change authorization decisions.
