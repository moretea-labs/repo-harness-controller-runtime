# Architecture Invariants

> Status: **Runtime Authority**

These invariants are the architectural constitution of repo-harness Controller Runtime. Implementation Tasks may improve how they are enforced, but may not weaken them without an accepted ADR.

## Invariant 1 — MCP Requests Do Not Own Long Work

**Current Implementation — MUST**

Any operation that may exceed a short request budget MUST become a durable Job and return an identifier before execution completes.

This includes:

- Agent execution;
- heavy checks;
- edit-session verification with long checks;
- repository commands;
- integration;
- release gates;
- multi-repository rollout;
- schedule-driven work.

**Compatibility Rule**

Controller-profile long and mutating handlers use the durable Job path. Legacy operation implementations are Worker-only compatibility adapters and MUST NOT be invoked by Gateway request handlers.

## Invariant 2 — Persist Before Execute

**Current Implementation — MUST**

The system MUST persist accepted intent, identity, scope, deadline, and idempotency data before starting a Worker or external session.

Forbidden order:

```text
spawn -> later attempt to save
```

Required order:

```text
validate -> persist -> acknowledge -> dispatch
```

## Invariant 3 — Every Mutation Is Idempotent

**Current Implementation — MUST**

Every write or execution command MUST have a stable idempotency identity derived from:

```text
requestId + repoId + operationType + semanticKey
```

A repeated request MUST reuse or return the original accepted entity. It MUST NOT create duplicate Jobs, Runs, Issues, Occurrences, integrations, or releases.

Schedule-triggered work uses:

```text
scheduleId + repoId + occurrenceWindow
```

## Invariant 4 — Task Is Intent; Run Is Attempt

**Current Implementation and Target Architecture — MUST**

A Task defines one objective, scope, dependencies, checks, risk, and acceptance criteria. A Run records one Agent execution attempt.

A failed Run remains failed. Retry creates a new Run. Historical Runs are evidence and cannot resurrect a terminal Task.

Run success does not by itself mean Task completion.

## Invariant 5 — Job and Run Are Distinct

**Current Implementation — MUST**

A Job represents an asynchronous system operation. A Run represents an Agent attempt.

A dispatch Job may create or link a Run. Check, command, verification, integration, release, and reconciliation Jobs do not need an Agent Run.

Job status MUST NOT be inferred solely from “a Run was dispatched.” It reaches terminal state only when its owned operation reaches terminal state.

## Invariant 6 — One Logical Scheduler Owns Each Repository

**Current Implementation — MUST**

One logical Repo Actor owns repository-local ordering, claims, conflict decisions, integration, and release freeze.

Multiple Workers may execute concurrently, but no other component may independently decide repository-local write ordering.

Focus is presentation state, not an execution lock.

## Invariant 7 — Repository Failures Are Isolated

**Current Implementation — MUST**

A blocked, overloaded, corrupt, or disconnected repository MUST NOT block unrelated repositories.

Global resource limits may delay work fairly, but repository locks, heavy-check queues, dirty workspaces, integration conflicts, or release freezes remain repository-scoped.

## Invariant 8 — Unknown Write Scope Is Conservative

**Current Implementation — MUST**

A non-read-only Task with empty or unknown allowed paths claims repository-wide write scope for conflict purposes.

Unknown scope MUST NOT be interpreted as proof that two write operations are independent.

A Task may regain concurrency only after scope becomes explicit or execution is isolated in a Worktree with serialized integration.

## Invariant 9 — Workspace Has One Writer

**Current Implementation — MUST**

One checkout Workspace may have at most one active write owner.

Read-only work may run concurrently. Independent write work must either:

- wait for the Workspace claim;
- execute in a separate Worktree;
- use an external branch/provider.

Direct Edit and Workspace Agent execution use the same single-writer boundary.

## Invariant 10 — Worktrees Enable Execution Concurrency, Not Integration Concurrency

**Current Implementation — MUST**

Worktree executions may run concurrently when resources allow. Integration into one target checkout is serialized.

Integration MUST validate the reviewed diff, target revision, supported file operations, and current workspace state. Conflicts preserve the Worktree and surface an explicit state; they are not silently rebased or overwritten.

## Invariant 11 — Locks Protect Transactions; Leases Protect Execution

**Current Implementation — MUST**

Short locks protect atomic state decisions. Long execution is protected by renewable Leases.

A Lease includes:

```text
leaseId
resourceKey
ownerJobId
fencingToken
acquiredAt
expiresAt
heartbeatAt
```

A stale Worker MUST NOT update state after a newer fencing token has taken ownership.

## Invariant 12 — Durable Truth Is Not In Memory

**Current Implementation and Target Architecture — MUST**

In-memory maps, promises, queues, UI state, and chat history are caches or coordination aids only.

Accepted work, lifecycle state, ownership, evidence, and terminal outcomes MUST be recoverable from persisted state.

When Controller restart loses an in-memory optimization, persisted indexes or bounded reconciliation must restore correct behavior.

## Invariant 13 — Hot Reads Use Bounded Projections

**Current Implementation — MUST**

Status and list endpoints MUST read bounded indexes or materialized projections.

They MUST NOT linearly scan all history, load complete logs, calculate every repository revision, or reconcile every historical entity for one compact response.

Explicit detail tools may perform bounded entity-specific reads.

## Invariant 14 — Execution and Observation Are Independent

**Current Implementation — MUST**

Heavy work MUST NOT prevent health, repository status, Job status, Run status, or controller context queries from responding.

Gateway and projection availability are separate from Worker health. A Worker crash may degrade readiness but MUST NOT take down lightweight observation.

## Invariant 15 — State Writes Are Atomic

**Current Implementation — MUST**

Lifecycle snapshots, indexes, Job records, Run metadata, results, verification records, and Lease state MUST be written atomically.

Readers must never observe a half-written JSON document. Append-only event logs must use complete records and tolerate a trailing incomplete record after a crash.

## Invariant 16 — Evidence Binds to Exact Revision

**Current Implementation — MUST**

Verification evidence includes:

```text
repoId
checkoutId
revision
check or command identity
environment fingerprint
executedAt
artifact reference
```

If relevant repository state changes, prior evidence becomes stale for completion purposes unless the check contract explicitly proves it remains valid.

## Invariant 17 — Worker Self-Report Is Not Acceptance

**Current Implementation and Target Architecture — MUST**

An Agent may report that implementation is complete. The Controller determines completion using reviewed diff or integrated revision, required checks, acceptance criteria, and risk policy.

High-risk or destructive work requires explicit human acceptance after evidence passes.

## Invariant 18 — Retry Preserves History

**Current Implementation and Target Architecture — MUST**

Retry creates a new attempt or occurrence. It does not mutate the failed attempt into success.

The original error, output, timestamps, resource ownership, and evidence remain addressable.

## Invariant 19 — Cancellation Is Scoped

**Current Implementation — MUST**

Cancelling one subscriber, Job, or client request MUST NOT terminate a shared execution still required by another active subscriber.

Shared checks and deduplicated work maintain independent subscriber state. The shared Worker may be terminated only when no active owner remains or policy explicitly requires global cancellation.

## Invariant 20 — Conflict Is Usually a Waiting State

**Current Implementation — MUST**

Resource contention is modeled as:

```text
waiting_for_workspace
waiting_for_worktree
waiting_for_heavy_check
waiting_for_integration
waiting_for_release_barrier
waiting_for_dependency
```

It should not be reported as execution failure unless the deadline expires, policy is violated, or the conflict is irrecoverable.

## Invariant 21 — Scheduled Work Is Bounded

**Current Implementation — MUST**

A Schedule does not own a forever-running Agent. Each trigger creates one bounded Occurrence with:

- an idempotency window;
- scope;
- budget;
- maximum active count;
- deadline;
- retry/backoff policy;
- stop conditions;
- an explicit outcome.

A valid outcome may be `nothing_to_do`.

## Invariant 22 — Automation Does Not Invent Unlimited Work

**Current Implementation — MUST**

Automated triage may create a Candidate Finding. It may create or update a formal Issue/Task only when evidence and configured policy justify it.

The same semantic problem must deduplicate across occurrences. “The Agent suggests an optimization” is not sufficient evidence by itself.

## Invariant 23 — External Side Effects Remain Explicit

**Current Implementation and Target Architecture — MUST**

The system MUST NOT automatically force-push, rewrite history, publish packages, deploy to production, merge changes, delete unique remote work, or execute destructive data operations without explicit same-request authorization and the required review boundary.

## Invariant 24 — One Rule Has One Owning Document

**Current Implementation — MUST**

Normative architecture rules live in the document assigned by `governance.md`. Other documents link to the owner rather than maintaining a competing copy.

Versioned design documents cannot override the current set.

## Invariant 25 — Architecture Claims Must Remain Executably Verifiable

**Current Implementation — MUST**

A capability may be labeled implemented only when a repository path and an executable check support the claim. Future gaps or regressions must be linked to an Issue/Task or ADR rather than hidden by documentation wording. The completed migration record is not permission to weaken a boundary without updating code, tests and the current architecture set.

## Invariant 26 — Runtime Source Identity Is Controller-Scoped

**Current Implementation — MUST**

Controller Runtime Source Identity is controller-scoped state. It is not session-scoped and not execution-repository-scoped.

MUST:

- Persist Runtime Source Identity only under `controllerHome` (`system/runtime-generation.json` and daemon `state.json` source snapshot).
- Resolve the current Runtime Source from one authority: explicit handoff, `REPO_HARNESS_CONTROLLER_RUNTIME_SOURCE_ROOT` / `REPO_HARNESS_SOURCE_ROOT`, package/source entrypoint root, or cwd only when that cwd itself is the controller package.
- Compare drift only between the startup Runtime Source snapshot and the current Controller Runtime Source.
- Treat a missing startup snapshot as fail-closed (`RUNTIME_SOURCE_SNAPSHOT_MISSING`) rather than silent pass.
- Keep execution repository git state (`canonicalRoot`, branch, head, dirty) in repository status fields only.

MUST NOT:

- Use the selected execution repository `canonicalRoot` as the current Runtime Source for drift evaluation.
- Rotate Runtime Source generation on `session_bind_repository`, work preparation, worktree creation, or ordinary branch switches.
- Treat Runtime Source root differing from the selected execution repository as an error.
- Hardcode a clone directory name or user absolute path as the Runtime Source.

Primary implementation: `src/runtime/control-plane/runtime-generation.ts`, with shared consumers in MCP `rh_status`, CLI `controllerServiceStatus`, Local Bridge access state, keepalive, and daemon start.

## Invariant 27 — Transport Connectivity Is Not Execution Ownership

**Current Implementation — MUST**

An MCP SSE stream is a replaceable transport lease. It MUST NOT retain session capacity indefinitely and MUST NOT be treated as proof that durable work is still executing.

- `/mcp`, `/mcp-grok`, and `/mcp-bearer` MUST share one global session-capacity authority.
- Client DELETE, explicit prior-session replacement, bounded stream lease, absolute lifetime, and capacity pressure MAY close a session that has no active POST.
- Session-capacity management MUST NOT evict a session with active POST work.
- Closing a transport MUST NOT cancel a durably accepted Job.
- Liveness and admission readiness MUST remain separate signals.

## Review Use

Every architecture-sensitive Task should cite the invariants it affects. Verification should include a statement that the resulting implementation preserves them or an accepted ADR that changes them.
