# Failure Recovery

> Status: **Runtime Authority**

## 1. Objective

Failure recovery preserves durable truth when client connections, Gateway sessions, Controller processes, Workers, Agents, external providers, repositories, or indexes fail independently.

The recovery objective is not to turn every uncertain state into success. It is to determine what can be proven, preserve evidence, prevent duplicate unsafe execution, and expose an explicit next action.

## 2. Failure Domains

The target runtime has distinct failure domains:

```text
Client / MCP session
Gateway
Controller Daemon
Repo Actor
Worker
Agent or command process tree
External provider
Repository checkout
Controller Home storage
Projection / index
Network tunnel or reverse proxy
```

A failure in one domain must not automatically terminate or corrupt another domain.

## 3. Client and Transport Failure

Examples:

- MCP client disconnects;
- reverse proxy returns 502;
- tunnel changes endpoint;
- Streamable HTTP session is lost;
- request exceeds proxy timeout;
- response body is truncated.

### Target Behavior

If a command was durably accepted before disconnection:

- the Job continues according to its contract;
- repeated request with the same idempotency key returns the existing Job;
- the client can recover through `get_job`, `get_run`, or related detail tools;
- the original connection is not execution ownership.

If durable acceptance cannot be proven, the caller may retry using the same request ID.

### Health Requirement

Gateway health endpoints and compact status queries must not wait for active long operations.

A 502 may describe Gateway or proxy availability. It must not be used as evidence that a Job failed or never started.

## 4. Gateway Failure

The Gateway is stateless except for transport/session caches and bounded projections.

After restart it must:

1. reload authentication and tool-surface configuration;
2. reconnect to Controller Daemon or Controller Home;
3. expose the same stable repository and Job identities;
4. reject or redirect stale MCP sessions cleanly;
5. avoid resubmitting accepted work without idempotency lookup.

Gateway restart must not cancel Workers.

## 5. Controller Daemon Failure

The Controller Daemon owns scheduling decisions, Repo Actors, reconciliation, Schedule delivery, and Lease management.

After restart it must persist `starting`, run bounded synchronous recovery, and publish `ready` only after that recovery returns:

```text
load enabled repository registry
rebuild ExecutionJob active and requestId indexes from durable records
reconcile running/active ExecutionJobs and dead workers
reconcile Local Bridge compatibility Jobs
remove or classify expired Leases
rebuild every repository materialized projection from durable truth
publish ready, including degraded state and structured recovery errors
resume fair scheduling and normal asynchronous observation
```

Projection rebuild is unconditional on daemon restart, so a stale persisted projection is repaired even when a dirty marker was lost. Recovery failures are isolated by repository and phase: one broken repository does not prevent healthy repositories from recovering, and a failure in one phase does not silently skip later Lease or projection repair. The Controller must not assume every persisted `running` entity is still running. It verifies Lease, heartbeat, process/provider state, and durable result evidence.

## 6. Repo Actor Recovery

A Repo Actor is a logical single owner. Its mailbox and sequence position must be recoverable.

Actor recovery reads:

- repository enabled state;
- active Jobs and Claims;
- Leases and fencing tokens;
- Task effective states;
- Workspace and Worktree ownership;
- Integration Queue;
- release freeze;
- pending Schedule Occurrences.

Commands are applied idempotently by command ID or request ID. Replaying an already-applied command returns the recorded result.

## 7. Worker Failure

A Worker may exit because of:

- process crash;
- host restart;
- timeout termination;
- explicit cancellation;
- resource exhaustion;
- launch error;
- lost Controller connection.

Worker liveness is not inferred only from a parent PID. Recovery considers:

```text
Lease validity
fencing token
worker PID
child and process-group state
heartbeat
result artifact
stdout/stderr/event completion
external provider state
```

A dead Worker with a complete valid result may be reconciled to terminal success. A live descendant without a valid Lease must not retain state-write authority.

## 8. Process Tree Ownership

Local execution must record enough data to identify the complete process tree or process group.

Timeout or cancellation procedure:

```text
record termination intent
signal process group gracefully
wait bounded grace period
signal remaining group forcefully when allowed
record observed exit state
persist unresolved descendants if any
release Lease only after ownership transition is durable
```

A parent process exit is not sufficient evidence that compilers, tests, or Agent descendants have exited.

## 9. External Provider Failure

For GitHub or another provider:

- local Run stores provider session identity and links;
- provider status is refreshed independently from MCP connection;
- unavailable provider state yields a retriable external blocker or `unknown`, not fabricated success;
- duplicate provider sessions are prevented by request identity;
- external branch/PR existence is evidence, not automatic acceptance.

## 10. Storage Failure

Controller Home and repository runtime bindings are durable state dependencies.

On write failure:

- do not start a new Worker;
- do not advance lifecycle in memory only;
- return a storage-blocked result;
- preserve temporary files for diagnostics where safe;
- avoid deleting the prior valid snapshot.

Atomic-write protocol:

```text
write temporary file
flush when required by risk class
rename atomically
update index after entity snapshot
append audit event or record repair anomaly
```

If entity write succeeds and index update fails, reconciliation rebuilds the index from bounded durable entities.

## 11. Projection and Index Recovery

Indexes are rebuildable projections.

Target indexes include:

```text
active Jobs
requestId -> entity
Task -> Run IDs
active Claims and Leases
pending Integration Queue
active Schedule Occurrences
Candidate Finding semantic keys
recent attention items
```

Rules:

- hot reads use indexes;
- index owner/version is persisted;
- process restart may validate or rebuild active indexes;
- a missing terminal-history index does not require scanning history on every request;
- rebuild runs as a bounded reconciliation Job when history is large;
- malformed entities are isolated and reported rather than silently discarded.

## 12. Lease Recovery and Fencing

A Lease may be:

```text
active
expired
released
revoked
orphaned
```

Recovery procedure:

1. read persisted Lease and resource fencing counter;
2. determine whether current owner Job is non-terminal;
3. inspect heartbeat and execution evidence;
4. if ownership is uncertain, prevent new writes until expiry or explicit revocation;
5. grant new ownership with a higher fencing token;
6. reject late writes carrying the older token.

Process PID reuse must not grant ownership. The Lease ID and fencing token are authoritative.

## 13. Orphan Classification

Use `orphaned` when:

- an active owner disappeared;
- no valid terminal result proves success or failure;
- repeating the operation may have side effects;
- manual or policy-guided reconciliation is required.

Orphan metadata includes:

```text
lastHeartbeatAt
leaseExpiredAt
lastKnownPid/provider state
lastEvent
artifact completeness
safeToRetry
reconciliationReason
```

## 14. Unknown Run Classification

A Run uses `unknown` when execution outcome cannot be proven, including startup ambiguity or provider uncertainty.

Unknown does not mean failed, succeeded, or safe to retry. Task readiness must require explicit retry authorization after the Controller evaluates duplicate-execution risk.

## 15. Stale Classification

Use `stale` when the operation may have executed correctly but cannot satisfy the original contract because a required precondition changed.

Examples:

- repository Revision changed;
- Edit Session advanced to another Revision;
- approval token snapshot changed;
- integration target moved;
- Schedule window was superseded;
- repository identity or provider mapping changed.

Stale evidence remains historical but cannot complete the current Task.

## 16. Timed-Out Classification

A timeout requires:

- a persisted deadline;
- observed deadline expiry;
- termination or provider cancellation attempt;
- durable timeout event;
- resource-release/reconciliation outcome.

An in-memory timer firing without durable deadline identity is insufficient recovery evidence.

## 17. Retry Safety

Before retry, determine operation class:

### Naturally idempotent

Examples: bounded read, exact-revision check with cache key.

May retry automatically within budget.

### Idempotent through request identity

Examples: Job admission, Run creation, Schedule Occurrence creation.

Retry returns the original entity.

### Requires reconciliation

Examples: command may have modified files, Agent may still be alive, external provider session may exist.

Do not retry until current outcome and resource ownership are reconciled.

### Explicitly non-repeatable

Examples: publication, deployment, destructive mutation.

Require human decision and operation-specific compensation or resume protocol.

## 18. Reconciliation Jobs

Reconciliation is itself durable and bounded.

Types include:

- active Job reconciliation;
- active Run reconciliation;
- Lease reconciliation;
- Worktree inventory reconciliation;
- Integration Queue reconciliation;
- repository registry identity reconciliation;
- Schedule Occurrence reconciliation;
- projection rebuild.

Reconciliation Jobs must be idempotent and normally read-only except for lifecycle repair and index updates.

## 19. Startup Sequence

Controller startup order:

```text
1. validate Controller Home
2. load repository registry
3. validate runtime storage bindings
4. load/rebuild global active indexes
5. instantiate Repo Actors
6. reconcile Claims and Leases
7. reconcile active Jobs/Runs/Occurrences
8. start Worker dispatch
9. deliver due Schedules
10. report readiness
```

Gateway may report liveness before Controller readiness, but execution admission must wait for durable state readiness.

## 20. Health Model

### Liveness

The process event loop responds.

### Readiness

The component can safely perform its role.

Suggested health surfaces:

```text
Gateway /health
Gateway /ready
Controller status
Worker pool status
Repository-specific health
```

Repository-specific degradation does not make Gateway liveness fail.

## 21. Recovery Notifications

Notify only on material state change:

- Job recovered to terminal outcome;
- Job became orphaned/unknown;
- retry is unsafe without user decision;
- repository storage is blocked;
- integration conflict requires action;
- repeated Controller/Gateway instability crosses policy threshold.

Do not repeatedly notify for an unchanged orphan or external blocker.

## 22. Recovery Testing

Required test scenarios include:

- client disconnect after Job acceptance;
- Gateway restart during Worker execution;
- Controller restart with running Jobs;
- Worker crash before and after result persistence;
- process descendants surviving parent exit;
- expired Lease and late stale Worker write;
- corrupt/missing active index rebuild;
- repeated request ID after timeout;
- external provider temporarily unavailable;
- repository A recovery while repository B continues.

## 23. Current Implementation

Gateway, Controller Daemon and Worker are separate process roles. Accepted Jobs are persisted before Worker spawn. Job heartbeat, deadline, attempt, PID, Lease and fencing state are durable. Active and request indexes reconstruct scheduling after restart.

Before an operation runs, the Worker writes an Operation Receipt. A completed receipt lets Reconciliation close a Job after a crash between side-effect completion and terminal-state persistence. A started-but-incomplete mutating receipt is treated as an uncertain side effect and becomes `human_attention_required`; it is not replayed. Safe read-only work may be requeued within attempt budget.

Worker ownership is the tuple of Job ID, attempt, Worker PID and original Lease/fencing set. A stale Worker cannot heartbeat, renew or release replacement Leases, or publish a terminal result for a newer attempt.

The Gateway does not infer execution failure from a disconnected request. Callers recover with the request ID or Job ID. Cancellation terminates the owned Worker, records a terminal state and releases only that attempt's Claims.

## 24. Recovery Invariants

- a restarted Gateway never owns Worker lifetime;
- a restarted Daemon schedules from active indexes;
- a stale Worker cannot write through an expired or replaced fencing token;
- external effects are reconciled rather than blindly retried;
- repository A recovery does not require locking repository B;
- bounded projections remain readable while Workers execute.

## Campaign Recovery

Campaign state survives Gateway, MCP, ChatGPT, scheduler, and worker restarts. Reconciliation treats persisted Execution Jobs and Agent Runs as the execution source of truth. Missing, orphaned, timed-out, or human-attention child work becomes a bounded Campaign task failure and may open a Supervisor Checkpoint.

No in-memory ChatGPT conversation is required for recovery. Duplicate review delivery and scheduler delivery are idempotent. A stale checkpoint nonce, stale goal revision, or conflicting request-ID reuse is rejected rather than replayed against newer state.

### Campaign checkout recovery

Campaign worktree identity is stored in Controller Home with its request id, branch, path, and original base revision. Repeated creation reuses this manifest and registered checkout even if the source checkout advances. A missing directory is reconstructed from the retained branch after stale Git worktree metadata is pruned.

## 25. Campaign Cancellation Finalizer

Campaign cancellation is a two-phase state transition:

```text
active / paused / waiting_for_supervisor
  -> cancelling
  -> cancelled | cancelled_with_leaks
```

Entering `cancelling` blocks new Task dispatch, supersedes open checkpoints, and marks non-terminal Tasks cancelled. The finalizer then cancels Task and Supervisor Execution Jobs, which terminate owned process trees and release Leases. A managed Campaign worktree is removed only when its path and branch identity match and the workspace is clean. Unknown, dirty, or committed resources are preserved and reported as leaks.

`cancelled` is written only after the cleanup report is durable. Cleanup is idempotent; a Campaign in `cancelled_with_leaks` may be reconciled again after an operator resolves the preserved resource.

## 26. Runtime Storage Recovery

Every Controller Home runtime directory carries a repository/binding owner marker. Empty or terminal legacy storage is migrated and replaced with a repository-local link. Non-conflicting entries are merged. Name collisions are moved to a repository-scoped quarantine with a diagnostic path rather than overwritten or deleted.

Active or unreadable Run and Local Job directories remain fail-closed. Worktree storage is recoverable because stale and partial entries can be preserved or quarantined without claiming execution readiness based on deletion.
