# Scheduler and Resource Claims

> Status: **Runtime Authority**

## 1. Objective

The scheduler decides when accepted work may execute and where it may run. It protects repository state without turning every repository into a global serial bottleneck.

The core model is:

```text
Global Scheduler
  -> Repo Actor mailbox
     -> Job readiness
     -> Resource Claims
     -> Placement
     -> Lease
     -> Worker
     -> Integration Queue
```

## 2. Per-Repository Actor

### Target Architecture

Each Repository has one logical Repo Actor that serializes repository-local scheduling decisions.

Its mailbox accepts commands such as:

```text
admit Job
cancel Job
retry Job
grant/release Claim
renew/revoke Lease
reconcile active state
enqueue integration
enter/leave release freeze
update Task after evidence
```

The mailbox may be implemented through a single daemon queue, durable file queue, or equivalent mechanism. The invariant is single logical ownership, not one operating-system thread per repository.

### Actor Responsibilities

The Repo Actor owns:

- idempotency admission;
- dependency readiness;
- active write conflict decisions;
- Workspace and Worktree placement;
- Heavy Check ordering;
- integration ordering;
- release barriers;
- repository-local priority aging;
- reconciliation after restart.

It does not run Agent processes or long commands.

## 3. Global Scheduler

The Global Scheduler owns scarce system capacity:

```text
Agent process slots
Worker slots
Heavy Check slots
provider quotas
memory / CPU budgets
cross-repository priority
```

It does not inspect path-level repository conflicts itself. It asks the relevant Repo Actor for repository-local eligibility.

## 4. Resource Taxonomy

Resources use stable keys.

### Repository and Checkout Resources

```text
repo-state:<repoId>
workspace:<checkoutId>
git-index:<checkoutId>
git-refs:<repoId>
integration:<checkoutId>
release:<repoId>
remote-write:<repoId>
```

### Execution Capacity Resources

```text
agent-slot:<provider>
worker-slot:<class>
heavy-check:<repoId>
light-check:<repoId>
worktree-slot:<repoId>
```

### Path Resources

```text
path:<repoId>:<normalized-scope>
```

Path Claims are advisory scheduling precision layered on top of Workspace/Worktree isolation. They never weaken hard path-policy enforcement.

## 5. Claim Model

A Job declares required Claims before dispatch:

```text
resourceKey
mode: shared | exclusive
scope
reason
holdPhase
```

`holdPhase` identifies how long the resource is required:

- admission transaction;
- execution;
- integration;
- verification;
- release.

Claims are persisted so waiting state survives Controller restart.

## 6. Claim Compatibility

General compatibility:

| Existing | Requested | Compatible |
| --- | --- | ---: |
| shared | shared | yes, subject to quota |
| shared | exclusive | no |
| exclusive | shared | no |
| exclusive | exclusive | no |

Path compatibility adds scope comparison. Two explicit non-overlapping path scopes may execute concurrently only when placement and checkout resources also permit it.

Read-only work normally uses shared Claims and does not conflict with path writes unless it requires a repository mechanism that itself is exclusive.

## 7. Unknown Scope

A non-read-only Job with no trustworthy write scope claims:

```text
path:<repoId>:*
```

It conflicts with every other repository write scope.

This is intentionally stricter than treating missing scope as “no known conflict.” Unknown means uncertainty, not independence.

The Controller may reduce the Claim after bounded investigation identifies explicit paths.

## 8. Workspace Single Writer

A Checkout Workspace has one exclusive write Claim:

```text
workspace:<checkoutId>
```

The following all require it:

- Direct Edit;
- Workspace Agent execution;
- repository command classified as workspace write;
- integration into that Checkout;
- deterministic formatter or generator that writes files.

Read-only queries and processes may run concurrently if they do not require an exclusive Git/index resource.

## 9. Worktree Placement

Worktree execution requires:

```text
worktree-slot:<repoId>
git-refs:<repoId> during creation/cleanup
workspace:<worktreeCheckoutId> during execution
path claims for scheduling visibility
```

Worktrees allow implementation concurrency but do not bypass:

- Task dependencies;
- allowed/forbidden path enforcement;
- Agent/Worker quotas;
- integration serialization;
- release freeze policy.

## 10. Placement Algorithm

For one ready write Job:

```text
1. honor explicit workspace/worktree/provider request when safe
2. inspect current Workspace writer
3. inspect repository dirty state and ownership
4. inspect path scope and concurrent Jobs
5. prefer Workspace for one serial writer
6. choose Worktree when concurrency or isolation is required
7. wait when Worktree creation or later integration would be unsafe
```

A dirty Workspace is not automatically unavailable. The Actor distinguishes:

- changes owned by the same Edit Session/Job;
- unrelated user changes;
- staged/index changes;
- untracked generated artifacts;
- known runtime-only paths.

Unrelated user changes must be preserved. A new writer may be isolated or wait.

## 11. Conflict Matrix

| Work A | Work B | Default policy |
| --- | --- | --- |
| Read-only | Read-only | concurrent |
| Read-only | Workspace write | concurrent when read mechanism is safe |
| Direct Edit | Direct Edit, same Checkout | serialize |
| Direct Edit | Workspace Agent, same Checkout | serialize |
| Workspace Agent | Workspace Agent, same Checkout | serialize |
| Worktree Agent | Worktree Agent | concurrent subject to quotas |
| Worktree Agent, overlapping paths | Worktree Agent | may execute concurrently; integration serialized and conflict-checked |
| Workspace write | Worktree Agent | concurrent if Git ref operations are bounded and path policy allows |
| Light Check | Workspace write | configured by check purity; default shared read |
| Heavy Check | Heavy Check, same repo | serialize |
| Integration | Any Checkout writer | serialize on target Workspace |
| Git ref mutation | Another Git ref mutation | serialize per repository |
| Release Gate | New write admission | release freeze blocks new writes |
| Remote write | Remote write | serialize and require authorization |

## 12. Conflict Outcomes

Temporary resource contention produces waiting details, not failure:

```text
waiting_for_workspace
waiting_for_worktree_slot
waiting_for_agent_slot
waiting_for_heavy_check
waiting_for_git_refs
waiting_for_integration
waiting_for_release_barrier
waiting_for_dependency
```

Each waiting Job records:

```text
blockedResource
blockedByJobIds
queuedAt
priority
nextEvaluationAt
deadlineAt
```

Irrecoverable policy or scope violations fail before execution.

## 13. Short Locks and Long Leases

### Transaction Lock

Used for atomic operations such as:

- reserve request ID;
- create Job;
- transition Task;
- update active index;
- grant Claim;
- advance fencing token.

It should be held for milliseconds and released before Worker execution.

### Lease

Used for long ownership:

- Workspace writer;
- Worktree owner;
- Heavy Check execution;
- Integration;
- release freeze stewardship.

Leases are renewable, expiring, and fenced.

## 14. Fencing Tokens

Every exclusive resource maintains a monotonically increasing token.

When a new Lease is granted:

```text
fencingToken = previousToken + 1
```

A Worker includes the token on lifecycle and result writes. A write with an older token is rejected or recorded as stale evidence.

This prevents a paused or partitioned Worker from overwriting state after ownership moved.

## 15. Heavy and Light Checks

Checks declare a concurrency class.

### Heavy Check

Examples include full test, CI, release, public export, coverage, or controller-wide verification.

Default policy:

- one active per repository;
- global heavy-check quota;
- identical Revision/check requests share execution;
- Revision changes while queued make the old request stale;
- subscriber cancellation is independent.

### Light Check

Examples include type checks or focused tests when repository policy classifies them as light.

They may run concurrently up to a per-repository limit, but should not overload the same build cache or mutate generated files without explicit Claims.

## 16. Integration Queue

Every isolated change targeting the same Checkout enters one serialized queue.

Queue record:

```text
sourceRunId
reviewedDiffHash
baseRevision
targetCheckoutId
priority
enqueuedAt
requiredChecks
```

Integration flow:

```text
acquire integration + workspace Claims
  -> verify source evidence
  -> compare target Revision and dirty state
  -> apply deterministic patch
  -> persist Integration Record
  -> run focused verification
  -> release Claims
  -> clean Worktree only after durable success
```

On conflict:

- preserve the Worktree;
- mark integration conflict;
- release target Claims;
- create a focused repair action;
- do not rebase, reset, or overwrite automatically.

## 17. Priority and Aging

Within a repository, Jobs are ordered by:

```text
explicit priority
user-initiated over scheduled work
critical dependency path
wait age
risk and review boundary
estimated resource cost
```

Aging prevents low-priority Jobs from starving. Scheduled maintenance cannot continuously outrank a new user request.

## 18. Preemption

Default local work is non-preemptive once a Worker is actively writing. New higher-priority work waits or uses a Worktree.

Preemption may cancel only when:

- the Job contract declares it safe;
- no external side effect is in an uncertain state;
- a durable checkpoint exists;
- cancellation evidence and cleanup are recorded.

## 19. Release Freeze

When a repository enters Release Freeze:

- no new write Job is admitted for execution;
- existing writers may finish or be explicitly cancelled;
- Integration Queue must drain;
- read-only inspection and release checks may continue;
- Schedule Occurrences may triage but cannot dispatch mutation Jobs;
- the release Lease is exclusive.

The full release contract is defined in `verification-and-release-gates.md`.

## 20. Implemented Runtime and Maintenance Rule

The runtime now implements:

- one repository-specific actor mailbox;
- persisted Claims on every Execution Job;
- renewable Leases with monotonically increasing fencing tokens;
- conservative `repo-content:*` scope for unknown writes;
- explicit waiting states for Workspace, Heavy Check, Integration, release and dependencies;
- Workspace single-writer semantics and automatic Worktree placement for eligible Agent work;
- exclusive Integration, Git-ref, remote and release resources;
- global/per-repository capacity, provider quotas, Heavy Check limits and host-pressure admission;
- persisted priority aging and repository fairness state;
- owner-bound Worker heartbeat, Lease renewal, release and terminal writes.

New concurrency features must express their resources through this model. Additional ad-hoc long-lived locks require an ADR and may not execute on the Gateway event loop.

## Campaign Scheduling

The global scheduler runs bounded Campaign reconciliation outside the global dispatch reservation lock. Campaigns use one short lock per Campaign identity, while child Jobs continue to use normal resource claims and fencing tokens. This prevents one slow review or failed task from serializing unrelated Campaigns or repositories.

Agent Campaign tasks are normalized to `isolate: true` and therefore claim a task worktree rather than the active production workspace. Waiting Checkpoints carry no lease. Retry timestamps are durable and include bounded backoff and jitter to avoid retry storms.

### Campaign creation claims

`create_campaign` briefly claims repository state and `git-refs:<repoId>` while creating or recovering the deterministic Campaign worktree. Normal Campaign reconciliation uses short per-Campaign locks. Supervisor triggers claim no repository resource, and implementation Jobs claim the Campaign checkout or a task-specific child worktree.
