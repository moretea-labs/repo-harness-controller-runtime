# Job and Run Lifecycle

> Status: **Runtime Authority**

## 1. Purpose

This document defines asynchronous execution semantics. It prevents request lifetime, process lifetime, Job lifetime, Run lifetime, and Task lifetime from being treated as the same state machine.

## 2. Lifecycle Ownership

| Lifecycle | Owner | Answers |
| --- | --- | --- |
| Request | Thin Gateway | Was the command accepted and what ID should the client query? |
| Job | Repo Actor / Controller | What asynchronous system operation is pending or complete? |
| Run | Agent execution subsystem | What happened during one Agent attempt? |
| Task | Workflow Plane | Is the objective ready, under review, verified, accepted, or terminal? |
| Worker | Execution Plane | Which process currently holds execution ownership? |
| Lease | Resource subsystem | May this Worker still mutate the protected resource? |

No lifecycle may substitute for another.

## 3. Job State Machine

### Target States

```text
accepted
  -> queued
  -> waiting_for_resource
  -> dispatched
  -> running
  -> succeeded

accepted/queued/waiting_for_resource/dispatched/running
  -> failed
  -> timed_out
  -> cancelled
  -> orphaned
  -> stale
```

Optional review-oriented Jobs may include:

```text
running -> waiting_for_user -> running
```

### State Meanings

- `accepted` — durable record exists and idempotency identity is reserved.
- `queued` — eligible for scheduling but no Worker assigned.
- `waiting_for_resource` — blocked by a dependency, claim, quota, or barrier.
- `dispatched` — a Worker or external provider was assigned; execution may not have started.
- `running` — valid Lease and execution heartbeat exist.
- `waiting_for_user` — execution cannot progress without human input.
- `succeeded` — the Job-owned operation completed successfully and result evidence is durable.
- `failed` — operation completed unsuccessfully with durable error evidence.
- `timed_out` — persisted deadline was exceeded and termination/reconciliation was recorded.
- `cancelled` — an authorized cancellation ended this Job's ownership.
- `orphaned` — ownership disappeared and success/failure cannot be proven.
- `stale` — the operation's required revision or precondition changed before valid completion.

### Current Implementation

Local Bridge currently uses compatibility states such as `approved`, `running`, and `dispatched`. These remain readable. `approved` maps to accepted/queued semantics rather than a human approval queue.

### Migration Rule

New Job types should use the target meanings even if stored names remain temporarily compatible. A compatibility adapter must not mark a Job succeeded merely because a linked Run was created or dispatched.

## 4. Admission Protocol

Every long operation follows:

```text
1. validate repository, checkout, schema, policy and authorization
2. derive requestId and semanticKey
3. check idempotency index
4. evaluate Task/dependency and resource policy
5. atomically persist Job + accepted event + index entries
6. return Job ID to caller
7. schedule asynchronously
```

If step 5 fails, no execution may start.

If the client disconnects after step 5, the Job remains accepted.

## 5. Idempotency Protocol

### Identity

```text
idempotencyKey = hash(requestId, repoId, operationType, semanticKey)
```

### Behavior

- The first accepted command owns the key.
- Repeated calls return the original Job summary.
- A caller may explicitly request a new attempt only through retry semantics, producing a new attempt identity linked to the prior Job.
- A terminal failure is not silently rerun because the client repeated the original request.

### Semantic Keys

Examples:

```text
dispatch-task: issueId + taskId + retryFromRunId
run-check: checkId + revision + environmentFingerprint
verify-edit: sessionId + editRevision + checkSet
repository-command: approvalToken + checkoutSnapshot
integration: runId + targetCheckoutId + reviewedDiffHash
schedule-occurrence: scheduleId + occurrenceWindow + repoId
```

## 6. Scheduling and Claims

After admission, the Repo Actor computes required Claims.

Possible results:

- all Claims granted: assign Worker and Lease;
- compatible shared execution already active: subscribe to it;
- temporary conflict: enter `waiting_for_resource`;
- dependency incomplete: enter `waiting_for_dependency` detail;
- release freeze or policy block: wait or fail according to explicit policy;
- invalid scope or forbidden action: fail before Worker dispatch.

A waiting Job remains observable and retains its deadline and queue metadata.

## 7. Worker Start Protocol

A Worker starts only after:

1. Job is durable;
2. resource Claims are granted;
3. Lease with fencing token is persisted;
4. execution configuration and artifact paths are durable.

The Worker then records:

```text
workerAssigned
workerStarted
heartbeat
progress events
output references
terminal result
```

A PID is diagnostic evidence. Lease identity is the authority to write lifecycle state.

## 8. Heartbeat and Deadline

A running Job or Run records:

```text
startedAt
deadlineAt
heartbeatAt
leaseExpiresAt
worker identity
```

The Controller distinguishes:

- missing heartbeat but live process;
- dead process but unexpired Lease;
- expired Lease;
- completed result with missing terminal transition;
- process tree still alive after parent exit.

Timeout handling must attempt process-tree termination, record the signal path, wait for terminal confirmation or mark unresolved descendants, and persist the resulting state.

## 9. Run State Machine

### Current and Target Core States

```text
queued
  -> starting
  -> running
  -> waiting_for_user
  -> succeeded

queued/starting/running/waiting_for_user
  -> failed
  -> cancelled
  -> unknown
```

A timeout is represented by terminal failure/unknown metadata plus a structured termination reason until a dedicated Run `timed_out` status is introduced.

### Run Success Contract

For Workspace execution, Run success requires:

- Agent process exited successfully;
- result record is durable;
- declared process tree is closed;
- final diff/evidence can be read.

For isolated Worktree execution with automatic integration, Task-visible success requires either:

- integration completed, `integratedSessionId` exists, and cleanup is recorded; or
- Run execution succeeded but integration is explicitly pending/failed, in which case the Task remains review/integration pending and must not appear fully completed.

For GitHub execution, provider success and collaboration artifacts are recorded, but merge and acceptance remain separate.

## 10. Job-to-Run Relationship

A Dispatch Task Job may proceed:

```text
Job accepted
  -> Run accepted
  -> Run dispatched
  -> Job dispatched
  -> Run running
  -> Job running
  -> Run terminal
  -> continuation / integration / verification
  -> Job terminal
```

The Job may remain non-terminal after Run success while integration or required continuation remains part of the Job contract.

A Run terminal failure normally makes its owning dispatch Job fail, but Task retry semantics still require an explicit new Run.

## 11. Shared Execution

Identical check or deterministic execution requests may share one physical Worker execution.

The model is:

```text
SharedExecution
  -> Subscriber Job A
  -> Subscriber Job B
  -> Subscriber Job C
```

Rules:

- each subscriber has independent cancellation, timeout, stale, and result-link state;
- cancelling one subscriber does not kill the shared process while another subscriber remains active;
- the physical execution terminates only after the last subscriber leaves or the shared contract itself fails;
- every subscriber receives the shared result or its own scoped terminal outcome;
- shared identity includes Revision and execution environment.

In-memory subscriber sets may optimize delivery but must be reconstructable from durable Job relationships.

## 12. Cancellation

Cancellation targets an entity and authority boundary.

### Job cancellation

- marks that Job cancelled;
- releases or withdraws its Claims;
- removes its subscription from shared work;
- terminates a dedicated Worker only if the Job is its sole owner.

### Run cancellation

- attempts to stop the Agent process tree or provider session;
- records terminal evidence;
- does not delete Task or prior evidence.

### Request cancellation

A disconnected or abandoned MCP request after acknowledgement does not cancel the Job.

## 13. Timeout

Timeout is evaluated from a persisted deadline, not an in-memory timer alone.

On timeout:

1. confirm the Job is still owned by the same fencing token;
2. mark timeout intent;
3. signal the complete process tree or external provider;
4. persist termination events;
5. close or orphan the Lease;
6. record `timed_out` or `unknown` according to available evidence;
7. release Claims;
8. expose explicit retry semantics.

## 14. Orphan Reconciliation

A Job or Run may be orphaned when:

- Controller or Worker exits unexpectedly;
- persisted owner PID is dead;
- Lease expires without terminal result;
- external provider state is unavailable;
- result exists but lifecycle transition was interrupted.

Reconciliation order:

```text
1. read durable result/evidence
2. inspect Lease and fencing token
3. inspect process/provider liveness
4. inspect process tree and artifact completeness
5. recover terminal state when provable
6. otherwise mark orphaned/unknown
7. require explicit retry where duplicate execution is unsafe
```

Reconciliation must be idempotent.

## 15. Stale State

A Job becomes stale when a required precondition changes, including:

- repository Revision changed while a queued or running check required the old Revision;
- approval token no longer matches checkout snapshot;
- source Run diff no longer applies to target Checkout;
- Schedule Occurrence window was superseded;
- resource mapping or repository identity changed incompatibly.

Stale work must not produce reusable success evidence.

## 16. Retry

Retry creates a new attempt linked to the terminal entity:

```text
priorJobId
priorRunId
attemptNumber
retryReason
new requestId or retry identity
```

Before retry, the Repo Actor determines whether:

- the original operation is safe to repeat;
- a result may already exist;
- cleanup is complete;
- the repository Revision changed;
- scope or acceptance criteria must be revised;
- a different Agent is justified.

Infrastructure failure does not automatically imply implementation failure, and Agent failure does not automatically justify switching Agents.

## 17. Continuation After Successful Run

Successful Run continuation is deterministic:

```text
Run success
  -> inspect execution mode
  -> integrate when required
  -> run declared checks when policy applies
  -> persist Verification
  -> auto-complete eligible low/medium-risk Task
  -> wait for human acceptance for high/destructive Task
  -> unlock dependent Tasks
```

Every continuation step is either a durable Job or an atomic state transaction. A Controller restart can resume from the last durable boundary.

## 18. Terminal-State Rules

- `succeeded` requires durable result evidence.
- `failed` requires durable error evidence.
- `cancelled` requires cancellation authority and event.
- `timed_out` requires persisted deadline evidence.
- `orphaned` or `unknown` means the system cannot prove success or failure.
- `stale` means result cannot satisfy the original semantic contract.
- terminal entities do not return to running;
- retry creates a new entity or attempt relationship.

## 19. Projection Rules

Active indexes include only non-terminal Jobs/Runs. Terminal history is queried separately and bounded by requested limits.

A list endpoint may reconcile active entities but must not scan full terminal history. An entity detail endpoint may reconcile that entity specifically.

## 20. Audit Requirements

Every lifecycle transition records:

```text
entityId
previousStatus
nextStatus
actor
requestId
correlationId
causationId
fencingToken when applicable
reason
evidence references
occurredAt
```

Lifecycle transitions without an audit event are recovery anomalies and must be detectable by governance checks.

## 21. Controller Ownership Fencing

Repository controller ownership is a stable lease identity, not a per-Task token. Heartbeat or sibling dispatch renews/reuses the live owner and does not rotate its epoch. The epoch changes only on a proven takeover after the previous owner is dead or its record is malformed. Epoch writes are serialized and atomic.

A child Worker receives the current controller PID and epoch as a derived execution capability. It may publish heartbeats or terminal state only while that capability still matches the durable owner record. Parallel sibling Runs therefore cannot invalidate each other by reacquiring repository ownership.

## 22. Local Job Projection

Local Bridge states are compatibility projections of Agent Runs or durable Execution Jobs. `starting` is active and maps to `running`; it is never interpreted as terminal failure. A projected Local Job synchronizes its durable Job before applying action-specific orphan or timeout rules, preventing a compatibility projection from masking a terminal durable result.

Runtime storage is bound before the first Local Job is persisted. This prevents the Job from blocking migration of the directory that contains its own state.
