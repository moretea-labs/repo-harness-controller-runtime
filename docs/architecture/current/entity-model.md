# Controller Runtime Entity Model

> Status: **Runtime Authority**

## 1. Modeling Principle

repo-harness separates four kinds of truth:

1. **intent** — what should be achieved;
2. **execution** — what the system attempted;
3. **evidence** — what actually happened;
4. **projection** — what is convenient to display or query.

Entities from different categories must not be collapsed merely because they are currently stored in adjacent files or exposed by one tool.

## 2. Identity Hierarchy

```text
Repository (repoId)
  -> Checkout (checkoutId)
  -> Issue
     -> Task
        -> Job [0..N]
        -> Run [0..N]
        -> Edit Session [0..N]
        -> Verification [0..N]

Schedule
  -> Occurrence
     -> Job [0..N]

Portfolio Workflow
  -> Repository Node
     -> Issue / Task / Job reference
```

Resource control is orthogonal:

```text
Job / Run / Edit Session
  -> Resource Claim [0..N]
     -> Lease [0..1 active owner]
```

## 3. Repository

### Meaning

A Repository is the stable controller identity for one logical source repository.

### Identity

```text
repoId
```

`repoId` is not a branch name, filesystem path, remote URL, or GitHub repository string. Those values may change while existing durable entities retain their repository identity.

### Current Implementation

`RepositoryRecord` already stores stable identity, canonical root, remote metadata, checkout collection, GitHub mapping, enabled state, and Controller Home storage strategy.

### Target Architecture

A Repository owns exactly one logical Repo Actor and one repository-local scheduling domain.

### Migration Rule

Remote or path changes must be diagnosed and explicitly reconciled. They must not create a second active repository record for the same canonical repository or silently rebind existing entities.

## 4. Checkout

A Checkout identifies one local working copy or Worktree associated with a Repository.

```text
checkoutId
repoId
canonicalRoot
branch
worktree
```

A Repository may have multiple Checkouts. Workspace single-writer claims are scoped to a Checkout; repository ref, integration, and release claims may be scoped to the Repository.

## 5. Issue

### Meaning

An Issue is a durable container for one coherent defect, feature, investigation, or governance objective.

It owns:

- title and summary;
- goals and non-goals;
- Issue-level acceptance criteria;
- related artifacts;
- ordered Tasks;
- collaboration links;
- lifecycle and archive state.

### Rules

- An Issue is not an execution attempt.
- An Issue may remain active while some Tasks are done, blocked, or superseded.
- Current focus is a presentation hint, not exclusive execution ownership.
- An Issue becomes done only when its required Task and acceptance semantics are satisfied.

## 6. Task

### Meaning

A Task is the smallest durable work-intent unit that can be independently scoped, scheduled, verified, and accepted.

It owns:

```text
taskId
objective
dependsOn
allowedPaths
forbiddenPaths
checks
acceptanceCriteria
risk
notes
runIds
verification
```

### Rules

- A Task has one objective.
- Dependencies are Task identities, not Run identities.
- Agent selection occurs at dispatch time; a stored Agent is at most a recommendation.
- A Task may have multiple Runs and Edit Sessions across its history.
- A Task status expresses workflow intent and review state, not raw process state.

### Target Lifecycle

```text
backlog
  -> analysis
  -> planned
  -> ready
  -> executing
  -> review
  -> integrated
  -> verifying
  -> verified
  -> done
```

Alternative transitions include:

```text
ready/executing/review/verifying
  -> blocked
  -> changes_requested
  -> ready or executing

any non-terminal
  -> cancelled
  -> superseded
```

### Current Implementation

Current status names include `running` instead of a distinct `executing` abstraction and include compatibility states such as `launch_blocked`. Effective status also incorporates the latest Run.

### Migration Rule

Existing status values remain readable. New implementation must preserve the semantic distinction between declared Task status and effective execution state.

## 7. Job

### Meaning

A Job is one accepted asynchronous system operation.

Examples:

- dispatch an existing Task;
- start a Quick Agent session;
- run a named check;
- verify an Edit Session;
- execute a repository command;
- integrate a reviewed Run;
- execute a release gate;
- reconcile stale state;
- process one Schedule Occurrence.

### Required Identity

```text
jobId
repoId
operationType
requestId
semanticKey
```

### Required Metadata

```text
createdAt
updatedAt
status
requestedBy
payloadRef or bounded payload
resultRef
error
attempt
parentJobId
correlationId
causationId
deadlineAt
```

### Ownership

The Repo Actor owns Job admission and repository-local ordering. A Worker owns execution only while holding the Job's valid Lease.

### Rules

- Job creation precedes execution.
- A Job may create or link a Run, but is not a Run.
- Terminal Job records are immutable except for append-only audit annotations.
- Retry creates a new Job attempt linked to the prior Job unless the operation contract defines retry inside the same durable Job.

## 8. Run

### Meaning

A Run is one Agent execution attempt for one Task.

It owns:

```text
runId
issueId
taskId
agent
provider
executionMode
repoRoot / executionRoot
baseRevision
process identity
timeout / deadline
heartbeat
stdout / stderr / result / events
terminal outcome
integration metadata
```

### Rules

- A Run never changes which Task objective it attempts.
- A failed, cancelled, timed-out, or unknown Run remains historical evidence.
- Retry creates a new Run.
- A successful isolated Run is not accepted until its reviewed changes are integrated or explicitly represented by an approved external collaboration path.
- A Run self-report cannot mark its Task done.

## 9. Direct Edit Session

### Meaning

A Direct Edit Session is a transactional sequence of bounded deterministic file operations controlled by the Controller.

It owns:

```text
sessionId
purpose
allowedPaths
baseRevision
revisions
operations
savepoints
backups
aggregateDiff
requestedChecks
checkResults
review metadata
```

### Current Lifecycle

```text
open
  -> dirty
  -> checked
  -> finalized

 dirty/checked
  -> check_failed
  -> dirty

 open/dirty/checked/check_failed
  -> rolled_back
```

### Rules

- Each patch batch creates a numbered Revision.
- Every operation records before/after hashes where applicable.
- Checks apply to the current Edit Session Revision.
- A failed check does not require discarding the session; another correction Revision may follow.
- Finalization closes the transaction but does not by itself prove Task-level acceptance.

## 10. Integration

Integration is a deterministic operation that applies one reviewed change set to a target Checkout.

Integration may be represented as a dedicated Job and produces an Integration Record containing:

```text
sourceRunId or sourceEditSessionId
sourceBaseRevision
targetCheckoutId
targetRevisionBefore
targetRevisionAfter
reviewedDiffHash
appliedFiles
conflicts
cleanupOutcome
```

Integration is not an Agent role. Conflicts are explicit outcomes, not instructions to silently rebase or overwrite.

## 11. Verification

### Meaning

Verification is persisted evidence that declared checks and acceptance criteria were evaluated against a specific repository state.

A Verification Record owns:

```text
verificationId or embedded identity
repoId
checkoutId
revision
runId / editSessionId / integrationId
reviewedDiffHash
checkResults
commandEvidence
acceptanceResults
reviewer
verifiedAt
autoCompleted
```

### Rules

- Verification binds to an exact Revision.
- Evidence from an older relevant Revision becomes stale.
- Verification may fail and lead to `changes_requested`.
- Required checks are executed by the Controller or trusted repository systems; caller-provided success flags are not authoritative.

## 12. Acceptance

Acceptance is the workflow decision that evidence satisfies the Task or Issue contract.

Acceptance is distinct from Verification:

- Verification asks whether evidence passes the declared criteria.
- Acceptance asks whether the work may enter its final workflow state.

Low-risk work may auto-accept when policy and evidence allow. High-risk or destructive work requires human acceptance.

## 13. Check Execution

A Check Execution is a Job running one named deterministic repository check.

Its semantic identity includes:

```text
repoId
checkoutId
checkId
revision
environmentFingerprint
timeout contract
```

Identical active semantic identities may share one physical execution with independent subscribers. Completed evidence may be reused only while the cache key remains valid.

## 14. Resource Claim

A Resource Claim declares what an operation needs before it can run.

```text
claimId
repoId
jobId
resourceKey
mode: shared | exclusive
scope
state: requested | granted | released | expired
```

Examples:

```text
workspace:<checkoutId>
worktree-slot:<repoId>
path:<repoId>:src/cli/mcp/**
git-index:<checkoutId>
git-refs:<repoId>
heavy-check:<repoId>
integration:<checkoutId>
release:<repoId>
remote-write:<repoId>
```

A Claim expresses scheduling intent. A Lease expresses temporary execution ownership.

## 15. Lease

A Lease grants temporary ownership of one resource to one Job.

```text
leaseId
resourceKey
ownerJobId
fencingToken
acquiredAt
expiresAt
heartbeatAt
releasedAt
```

Rules:

- Leases expire unless renewed.
- A newer fencing token invalidates writes from older owners.
- A Worker process identity is evidence, not Lease identity.
- Process death allows reconciliation but does not itself define the final business outcome.

## 16. Schedule

A Schedule defines a recurring or condition-driven automation policy.

It owns:

```text
scheduleId
repository selector or portfolio selector
trigger
policy
work template
budget
retry and backoff
stop conditions
enabled state
```

A Schedule does not execute forever. It creates bounded Occurrences.

## 17. Occurrence

An Occurrence is one trigger window of one Schedule.

```text
occurrenceId
scheduleId
repoId
windowKey
requestId
status
decision
jobIds
budgetUsed
outcome
nextEligibleAt
```

One Schedule and window key may have at most one Occurrence. Outcomes include:

```text
nothing_to_do
work_dispatched
work_completed
work_failed
external_blocker
human_attention_required
release_ready
budget_exhausted
cancelled
```

## 18. Candidate Finding

A Candidate Finding is a structured automation observation that is not yet a formal Issue or Task.

It contains:

```text
findingId
semanticKey
repoId
sourceOccurrenceId
evidence
confidence
firstSeenAt
lastSeenAt
occurrenceCount
status
```

Promotion requires configured evidence. Repeated speculative suggestions must deduplicate instead of generating unlimited Issues.

## 19. Portfolio Workflow

A Portfolio Workflow coordinates dependency-aware work across multiple repositories.

It owns repository nodes and cross-repository dependencies but delegates each repository-local operation to that repository's Actor.

It uses Saga semantics rather than distributed atomic commit:

```text
prepare -> execute node -> verify node -> checkpoint -> continue
                                  \-> stop or compensate
```

## 20. Event and Projection

An Event is append-only history:

```text
eventId
eventType
repoId
entityType
entityId
requestId
correlationId
causationId
revision
occurredAt
dataRef
```

A Projection is a rebuildable read model. Projection corruption must not rewrite source lifecycle state; it is repaired from durable entities and events.

## 21. Relationship Rules

- One Issue owns many Tasks.
- One Task may own many Runs, Jobs, Edit Sessions, and Verification records.
- One Job may link at most one primary Run but may depend on child Jobs.
- One Run belongs to exactly one Task.
- One Occurrence belongs to exactly one Schedule and may create many Jobs.
- One active Lease has one owner Job and one fencing token.
- One resource may have many compatible shared Claims or one exclusive owner.
- One Verification applies to one exact repository Revision.

## 22. Deletion and Retention

Durable workflow and evidence entities are normally archived, not deleted.

Ephemeral Quick Agent Issue metadata may be cleaned after terminal completion, but Run and Job evidence remains durable according to retention policy.

Runtime projections, expired Leases, caches, and disposable Worktrees may be removed after durable terminal evidence and cleanup records exist.

## ChatGPT-Supervised Campaign

A Campaign is a durable project-level objective that coordinates existing Tasks, Execution Jobs, Agent Runs, Evidence, and human acceptance without replacing their lifecycles.

- A Campaign has revisioned goals and a stable goal hash.
- A Campaign Task references one existing MCP operation and explicit dependencies.
- A Checkpoint is a persisted ChatGPT review boundary, not a running Job.
- A Supervisor Decision is bound to one checkpoint nonce and goal revision.
- `waiting_for_supervisor` holds no worker or resource lease.
- `ready_for_human_acceptance` is not completion; only explicit human acceptance transitions to `completed`.

Campaign records are repository-scoped. Execution remains delegated to the existing durable Job and Agent Run models.

A Campaign owns an immutable `workspace` binding containing mode, checkout id, branch, root, original base revision, and whether repo-harness manages the worktree. ExecutionJob workers must resolve `job.checkoutId`; falling back to the active checkout is an identity violation.
