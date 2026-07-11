# Controller Runtime Implementation Status

> Status: **Runtime Authority**  
> Baseline: **Target Architecture Runtime — 2026-06-25**

## Completion Statement

The approved runtime topology is implemented in executable code:

```text
Thin MCP Gateway
  -> Global Scheduler
     -> Per-Repository Actor
        -> Durable Execution Job
           -> isolated Worker process
              -> Evidence / Artifact / Projection planes
```

The migration preserves the existing Issue, Task, Run, Edit Session, Local Job, repository and MCP contracts. Compatibility entities remain readable and operational; they no longer own long-work scheduling in the Controller profile.

## Capability Matrix

| Capability | Status | Runtime evidence |
| --- | --- | --- |
| Thin MCP Gateway | Implemented | `src/runtime/gateway/mcp/router.ts`, `src/cli/mcp/server.ts`, `src/cli/mcp/transports/http.ts` |
| Persist-before-execute durable commands | Implemented | `src/runtime/execution/jobs/store.ts`, global request index and semantic conflict detection |
| Independently restartable Controller Daemon | Implemented | `src/runtime/control-plane/daemon-entry.ts`, `daemon-client.ts` |
| Isolated Worker processes | Implemented | `src/runtime/execution/workers/worker-entry.ts`, Scheduler process spawning |
| Per-Repository Actor | Implemented | `src/runtime/control-plane/repo-actor/actor.ts`, actor registry and repository mailbox lock |
| Resource Claims | Implemented | `src/runtime/gateway/mcp/resource-policy.ts`, `resources/claims/conflicts.ts` |
| Renewable Leases and fencing tokens | Implemented | `src/runtime/resources/leases/store.ts` |
| Zombie Worker exclusion | Implemented | attempt/PID/exact-Lease ownership on heartbeat, renewal, release and terminal writes |
| Workspace single writer | Implemented | Workspace Claim conflicts and eligible automatic Worktree placement |
| Concurrent Worktrees with serialized integration | Implemented | unique Worktree Claims plus exclusive Integration/Git-ref Claims |
| Global fair scheduler | Implemented | priority aging, persisted repository fairness, global/repository quotas |
| Provider and host budgets | Implemented | Worker, Agent provider, Heavy Check, memory and CPU-load admission limits |
| Durable reconciliation | Implemented | heartbeat, deadline, Operation Receipt recovery, safe retry and ambiguous-mutation stop |
| Active/recent/request indexes | Implemented | Execution Job, Agent Run, Task-to-Run, pending integration, Local Job, Occurrence, Portfolio and Finding indexes |
| Schedule, Trigger, Decision and Occurrence | Implemented | interval/manual/UTC cron/calendar/condition/event/dependency triggers, bounded Occurrence and persisted Decision |
| Schedule safety policy | Implemented | Shadow Mode, max-active, daily budget, cooldown, exponential backoff, failure circuit breaker and stop conditions |
| Candidate Finding governance | Implemented | semantic dedupe, evidence, observation count and explicit human promotion |
| Personal-assistant plugin manifests and registry | Implemented | `src/runtime/plugins/`, Controller Home `plugins/`, MCP and Local Controller discovery |
| Portfolio DAG and Saga | Implemented | dependency-cycle rejection, deterministic stop and compensation under `src/runtime/workflow/portfolio/` |
| Evidence Plane | Implemented | unified append-only events, exact-revision evidence, Operation Receipts and bounded Artifacts |
| Materialized projections | Implemented | dirty-marker invalidation, indexed runtime projections and non-blocking Controller Context refresh |
| Release Freeze and Gate | Implemented | exclusive `release:<repoId>` Lease and deterministic exact-revision release manifest |
| External side-effect authorization | Implemented | Gateway/Portfolio/Schedule/Worker defense-in-depth policy |
| Runtime health split | Implemented | `/health`, `/ready`, `/repos/:repoId/health` |
| Legacy compatibility | Implemented | stable MCP facade, unchanged compatibility fingerprint, Local Job projection into Execution Job |
| Node/Bun process portability | Implemented | project TypeScript Loader for Daemon/Worker/Gateway smoke execution; Bun remains the supported package/test runtime |

## Public Contract and Tool Surface

The public MCP surface is stable and profile-compatible:

- `advanced` is the default repair-capable schema, capped at 128 high-value tools;
- `core` is retained as an alias for that same schema so legacy config cannot accidentally remove capabilities;
- `full` exposes every historical definition for exhaustive compatibility diagnosis.

The five preferred orchestration facades are `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`. Direct Edit, command, Git, Work/Job, Agent, Campaign, plugin, browser, iOS, artifact, and recovery entry points are also available in the stable schema. Request/Full Access changes execution approval only and never changes `tools/list` or requires reconnecting.

Potentially long or mutating calls acknowledge a durable Job, and their result remains available through `get_job` or bounded artifacts.

## Runtime Truth

Controller Home owns runtime state:

```text
repositories/<repoId>/
  execution-jobs/
  plugins/
  leases/
  schedules/
    records/
    occurrences/
    decisions/
    indexes/
  findings/
  artifacts/
  evidence/
  events/
  projections/
  runs/
  edit-sessions/

indexes/execution-jobs/
scheduler/state.json
portfolio/workflows/
```

Repository files under `plans/`, `tasks/` and Issue storage remain business intent and audit material. They are not scanned as a hot execution queue.

## Compatibility Boundary

The following remain supported:

- original Issue and Task lifecycle;
- Task/Run separation and retry history;
- Direct Edit sessions;
- Local Bridge API and UI;
- repository registry and GitHub mapping;
- Agent Run and Worktree integration records;
- legacy MCP schemas and stored-state readers;
- historical plans and architecture documents for audit.

`src/cli/mcp/tools.ts` is now a thin stable facade. `legacy-tool-service.ts` contains compatibility implementations invoked inside isolated Workers when work is durable. No product capability was removed to reduce source size or latency.

## Validation Authority

Completion is guarded by:

- strict TypeScript checking across `src`, `scripts` and `tests`;
- architecture invariant checks;
- MCP compatibility fingerprint checks;
- recovery, fencing and ambiguous-side-effect smoke tests;
- Schedule trigger/Decision/backoff smoke tests;
- Scheduler → Repo Actor → isolated Worker → Evidence process smoke;
- HTTP Gateway `/health`, `/ready` and repository-health smoke;
- package and source-manifest verification.

Release readiness requires Bun-native tests, TypeScript checking, MCP surface checks, public-document validation, tracked-file hygiene, and package export verification in the release environment.
