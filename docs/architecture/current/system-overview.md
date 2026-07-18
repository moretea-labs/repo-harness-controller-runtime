# Controller Runtime System Overview

> Status: **Runtime Authority**

## 1. System Definition

repo-harness Controller Runtime is an Agent Engineering Control Plane for one or more local Git repositories. ChatGPT, Local UI, CLI and optional GitHub integrations submit decisions and commands. The runtime persists accepted work, schedules it under repository-owned conflict rules, executes it outside the Gateway process and records evidence for recovery, acceptance and release.

## 2. Implemented Process Topology

```text
Client
  -> isolated stable ingress child (public loopback HTTP data plane)
       |
       v
  -> repo-harness-gateway (MCP HTTP/stdio)
       auth / schema / repository routing / hot projections / durable acknowledgement
       |
       v
     Controller Home
       execution job + request index + event ledger
       |
       v
  -> repo-harness-controller-daemon
       Global Scheduler
       Per-Repository Actors
       reconciliation / schedules / portfolio DAG
       |
       v
  -> repo-harness-worker (one bounded Job)
       command / check / Agent dispatch / integration / release gate
       |
       v
     repository workspace, Worktree, GitHub provider
       |
       v
     Evidence Plane + Materialized Projections
```

The processes communicate through atomic file-backed state. Gateway restart does not cancel accepted Jobs. Worker exit does not take down Gateway or Daemon. Daemon restart persists `starting`, rebuilds durable indexes and projections, reconciles Jobs, Local Jobs and Leases, and publishes `ready` only after bounded startup recovery returns. Partial recovery publishes structured degraded state instead of silently claiming health.

The Stable Supervisor lifecycle parent owns control and recovery decisions, while a supervised ingress child owns long-lived public proxy sockets. This data-plane/control-plane split prevents SSE connection count from sharing the lifecycle owner's event loop. The child reads `active-slot.json` for each request and exits when its parent identity disappears.

## 3. Thin Gateway

Implemented under:

- `src/cli/mcp/server.ts`
- `src/cli/mcp/transports/http.ts`
- `src/runtime/gateway/mcp/router.ts`
- `src/runtime/gateway/mcp/runtime-tools.ts`

The Gateway performs authentication, schema validation, repository selection, compact reads and Job admission. Mutating or potentially long legacy tools are converted to `ExecutionJob` records and acknowledged immediately. It does not start an Agent or wait for a full check in the HTTP request stack.

Bounded direct reads include health, Controller context, Job/Run status and bounded logs. Overload is rejected with explicit 429/503 responses instead of unbounded accumulation.

The three MCP HTTP paths share one global session registry. SSE streams are bounded transport leases, not work ownership. Client DELETE, explicit prior-session replacement, lease expiry, absolute lifetime and oldest-safe capacity eviction may close a session with no active POST; capacity management never evicts active POST work. `/health` reports the global pool, while `/ready` reports whether a new initialize can be admitted safely.

## 4. Global Control Plane

Implemented under `src/runtime/control-plane/`.

The Controller Daemon owns:

- fair cross-repository dispatch;
- global Worker and Agent quotas;
- provider-specific quotas;
- Heavy Check limits;
- host free-memory and CPU-load admission;
- Schedule ticks;
- Portfolio DAG progress;
- orphan/deadline reconciliation.

Fairness state is persisted, so restart does not permanently reset repository aging.

## 5. Per-Repository Actor

Each repository is represented by one logical `RepoActor`. Actor decisions are serialized by a repository-specific mailbox lock whose critical section contains only state reads, Claim decisions and state transitions.

The Actor owns:

- dependency readiness;
- repository-local priority and aging;
- Workspace/Worktree placement;
- Claim acquisition;
- Lease and fencing assignment;
- waiting-state classification;
- release barriers.

Long work runs after the Actor releases its short transaction lock.

## 6. Execution Plane

`ExecutionJob` is the common asynchronous protocol for:

- MCP operations;
- Agent dispatch;
- checks;
- Edit verification;
- repository commands;
- integration;
- release gates;
- reconciliation;
- Schedule occurrences.

Every Job has `requestId`, `semanticKey`, repository identity, deadline, attempts, Claims, Lease references and evidence IDs. Repeated request IDs return the same Job unless the semantic key differs, in which case admission fails explicitly. Repository command input has one canonical boundary: typed argv arrays preserve executable and argument boundaries end to end and execute without a shell; legacy command strings remain supported only through an explicit compatibility shell boundary. Preview, policy classification, scope checks, approval digests, durable payloads, Workers and the executor consume the same representation.

Worker processes heartbeat the Job and renew Leases. Fenced writes reject stale ownership. Result bodies are bounded; oversized results become addressable Artifacts.

## 7. Resource Plane

Stable resource keys include:

```text
repo-state
repo-content:*
workspace:<checkoutId>
worktree:<identity>
path:<glob>
git-refs:<repoId>
heavy-check:<repoId>
integration:<repoId>
remote:<repoId>
release:<repoId>
```

Unknown write scope becomes `repo-content:*`. Workspace writes are single-writer. A second automatically placed Agent may move to a unique Worktree Claim. Worktree implementation can run concurrently, but Integration and Git-ref mutation are exclusive.

## 8. Schedule and Portfolio Planes

A Schedule produces one idempotent Occurrence per normalized time window. Occurrences are bounded and indexed. Shadow Mode records the decision without mutation. Budgets, cooldowns, maximum active occurrences and failure circuit breaking are persisted.

A Portfolio Workflow is a cross-repository DAG. Dependencies are explicit. Failure policy is deterministic stop or Saga compensation. External side effects are blocked from unattended workflows.

## 9. Evidence and Projection Planes

Evidence contains exact revision, environment fingerprint, outcome, Job identity and artifacts. Event ledgers are append-only. Large output is not embedded in hot status responses.

Materialized projections summarize active Jobs, queue depth, workers, Leases, release freeze and human-attention states. HTTP readiness and Local UI read these projections rather than scanning history.

## 10. Release Plane

A Release Gate is a durable Job with an exclusive repository-wide release Claim. It checks:

- current Git revision and clean Workspace;
- active Jobs, Runs and Local compatibility Jobs;
- pending Worktree integration;
- non-final Edit Sessions;
- other Leases;
- active-Issue Task completion;
- exact-revision verification evidence;
- repository/Git/GitHub identity consistency;
- Controller Daemon readiness;
- package metadata.

The successful result is a release-ready manifest. Push, merge, publish and deployment remain separate, explicitly authorized operations.

## 11. Compatibility Layer

`src/cli/mcp/tools.ts` remains as a stable export facade; the preserved implementation is isolated in `src/cli/mcp/legacy-tool-service.ts`. Local Jobs and Agent Run records remain readable and operational for compatibility. In Controller mode, long compatibility implementations are invoked only by isolated Workers. The compatibility layer is not the scheduling owner.
