# Current Controller Runtime Architecture

> **Runtime Authority** — this directory is the approved architecture source for repo-harness Controller Runtime.

## Purpose

This directory defines the architecture that implementation work must converge toward. It exists to prevent runtime behavior from being inferred from whichever V5, V6, V7, V8, plan, research report, or Issue happens to be read first.

repo-harness is designed as an **Agent Engineering Control Plane**:

```text
Thin Gateway
  -> Global Control Plane
     -> Per-Repository Actor
        -> Durable Job Queue
           -> Isolated Worker
              -> Evidence Plane
```

The architecture is both technical and operational. It defines not only modules and processes, but also:

- who may decide;
- who may execute;
- how work is persisted and recovered;
- when tasks may run concurrently;
- what counts as a conflict;
- how multiple repositories share system resources;
- how scheduled work remains bounded;
- what evidence is required before completion or release.

## Authority Statement

The documents in this directory are the sole architecture authority for the current Controller Runtime.

The target topology is implemented. Normative documents may still distinguish current behavior, extension requirements and compatibility rules using these labels:

### Current Implementation

Verified behavior that exists in code, tests, persisted schemas, or observable runtime state.

Use this label only when a repository path or executable check can support the claim.

### Architecture Requirement

A non-negotiable behavior that current and future implementations must preserve. Runtime evidence is listed in `implementation-status.md`.

### Compatibility Rule

A rule that protects existing tools, stored state and callers while the runtime uses the new control-plane implementation.

## Reading Order

Read the architecture in this order:

1. `system-overview.md` — boundary, layers, and process topology.
2. `personal-assistant-plugin-baseline.md` — concrete assistant/plugin/GitHub/Gmail/Calendar boundary and migration baseline.
3. `architecture-invariants.md` — non-negotiable rules.
4. `entity-model.md` — durable entity meanings and ownership.
5. `job-and-run-lifecycle.md` — execution, retry, cancellation, and terminal-state semantics.
6. `dispatch-and-agent-strategy.md` — selection of Direct Edit, Quick Agent, durable Tasks, and Agent roles.
7. `scheduler-and-resource-claims.md` — repository actors, claims, leases, workspace conflicts, and integration queues.
8. `multi-repository-execution.md` — cross-repository quotas, fairness, DAGs, and failure isolation.
9. `automation-and-schedule-engine.md` — schedules, bounded occurrences, deduplication, budgets, and stop conditions.
10. `failure-recovery.md` — Gateway, Controller, Worker, orphan, stale, timeout, and reconciliation behavior.
11. `verification-and-release-gates.md` — exact-revision verification, acceptance, release freeze, and human authorization.
12. `implementation-status.md` — verified implementation coverage and compatibility boundaries.
13. `migration-roadmap.md` — completed phase record and maintenance gates.
14. `runtime-directory-map.md` — executable module boundaries.
15. `operations-runbook.md` — health, recovery and release operations.
16. `governance.md` — ownership, ADR, drift, and maintenance rules.
17. `session-aware-execution-and-authorization.md` — Session Context, Work Handle, Goal delegation, and resumable approval boundaries.
18. `runtime-health-and-resource-lifecycle.md` — shared health evaluation, projection freshness, capability status, attention/history, and bounded ownership-aware cleanup.
19. `stable-external-runtime-supervisor.md` — immutable external lifecycle ownership, recovery MCP, fencing, and slot cutover.
20. `human-interaction-plane.md` — foreground provider sessions, durable human handoff, profile fencing, and safe resumption.


## Architecture Layers

The approved top-level layers are:

| Layer | Primary responsibility | Must not own |
| --- | --- | --- |
| Thin Gateway | Authentication, validation, routing, compact reads, durable command acceptance | Long execution, Agent lifetime, heavy checks |
| Global Control Plane | Repository registry, global quotas, portfolio scheduling | Repository-local workflow mutation |
| Per-Repository Actor | Repository-local ordering, claims, conflict decisions, integration and release coordination | Cross-repository global locks |
| Workflow Plane | Issue, Task, Schedule, Occurrence intent and dependency state | Process lifetime and raw logs |
| Durable Execution Plane | Job acceptance, dispatch, Run attempts, commands, checks, workers | Product acceptance decisions |
| Workspace Plane | Workspace/worktree allocation, Git integration, resource leases | Business intent |
| Evidence Plane | Diffs, checks, logs, artifacts, verification and release evidence | Scheduling policy |
| Projection Plane | Compact snapshots, indexes, dashboard and MCP read models | Source-of-truth state mutation |

## Source-of-Truth Rules

- Issue and Task files own durable work intent.
- Jobs own asynchronous system-operation state.
- Runs own individual Agent execution attempts.
- Edit Sessions own transactional direct modifications.
- Verification records own exact-revision completion evidence.
- Event logs own audit history.
- Atomic snapshots and indexes are projections optimized for reads and recovery.
- The controller task ledger projection (`.ai/harness/controller/task-ledger.json` and `.ai/harness/handoff/controller-current.md`) is a compact recovery/read model derived from durable Issue, Task, Run, and worklog state; its `status` field is a deterministic continuation hint for controller recovery, not a competing mutable task source.
- The controller context pack is a transient Projection Plane read model for scoped code investigation. It may return live Git metadata, validation hints, ranked candidate files, and bounded raw snippets, but it must not become source-of-truth for implementation decisions or replace exact source, diff, and validation review.
- Chat history, UI state, worker self-reports, and in-memory maps are never durable truth.

## Historical Documents

Superseded V5–V8 decisions are consolidated in [`docs/architecture/history.md`](../history.md), which is explicitly **Historical Design — Not Runtime Authority**. Detailed legacy documents are retained by Git history rather than published as parallel architecture surfaces.

The history may describe behavior that still exists, behavior that was removed, or behavior not yet migrated. It never overrides this directory.

## Change Discipline

A change requires architecture review when it modifies any of the following:

- process or service boundaries;
- authority or ownership of state;
- entity meanings or lifecycle transitions;
- task dispatch or Agent-selection behavior;
- concurrency, conflict, claim, lease, or integration semantics;
- multi-repository isolation or fairness;
- schedule, retry, budget, or stop-condition behavior;
- verification, acceptance, release, or destructive-operation boundaries;
- public MCP execution contracts or durable schema compatibility.

The expected sequence is:

```text
request or ADR
  -> current architecture update
     -> implementation Task
        -> executable verification
           -> architecture drift check
```

Implementation may precede the documentation update only for an urgent incident fix. In that case the change must record a temporary architecture drift item with an owner and closure condition.

## Completion Standard

The architecture baseline is complete only when:

- every required document exists;
- terms have one meaning across documents;
- Current Implementation and Target Architecture are distinguishable;
- every normative invariant has an implementation owner or migration item;
- historical documents are visibly non-authoritative;
- automated checks protect the document set and authority markers;
- future Issues can cite these documents instead of reconstructing strategy from conversation history.

See [Architecture Governance Contract](governance.md).


- [Repo Harness + ChatGPT current comprehensive architecture (zh-CN)](chatgpt-repo-harness-current-architecture.zh-CN.md)
- [Approved target architecture (zh-CN)](approved-target-architecture.zh-CN.md)
- [Personal assistant/plugin baseline](personal-assistant-plugin-baseline.md)
- [Target requirements traceability](target-requirements-traceability.md)
- [Human interaction plane](human-interaction-plane.md)
