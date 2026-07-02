# Plan: ChatGPT-Supervised Automation

> **Status**: Approved and executing
> **Baseline**: uploaded source archive `repo-harness-source-20260702-201141`
> **Branch**: `feature/chatgpt-supervised-automation`

## Goal

Add a durable campaign layer that lets ChatGPT supervise a multi-step repository goal while repo-harness continuously schedules and recovers execution. Codex, Claude, GitHub Copilot, browser interaction, and Computer Use remain execution capabilities; the campaign layer limits only unsafe external effects, runaway resource use, and lifecycle states that can deadlock or stall the controller.

## Architectural placement

```text
ChatGPT / another supervisor client
        │ get_review_packet / submit_review
        ▼
Campaign state + Checkpoints (new)
        │ short, idempotent reconciliation
        ▼
Existing ExecutionJob + RepoActor + leases + GlobalScheduler
        │
        ├── existing MCP operations
        ├── Codex / Claude / GitHub Copilot Task Runs
        ├── browser / Computer Use verification operations
        └── checks, integration, repository commands
```

The campaign layer does not hold workers, Git worktrees, MCP sessions, or model calls open. Every wait is persisted and every external action is represented by an existing durable ExecutionJob or Agent Run.

## Non-negotiable invariants

1. No campaign-wide or scheduler-wide lock is held while waiting for a model, Agent Run, check, browser action, or human.
2. Reconciliation uses a short per-campaign lock and idempotent request IDs.
3. A failed task blocks only its dependants; unrelated runnable tasks continue.
4. Each Campaign defaults to a long-lived feature worktree; Agent implementation tasks default to `isolate: true` and integrate only into that Campaign checkout.
5. Retry is bounded, delayed with exponential backoff and deterministic jitter, and owned by the campaign reconciler rather than a worker loop.
6. Review checkpoints hold no workspace or execution lease.
7. Existing safety gates remain authoritative for destructive, irreversible, remote, release, and credential-sensitive effects.
8. Completion stops at `ready_for_human_acceptance`; merging `main`, publishing, and release remain separate authorized operations.

## Delivery slices

### Slice 1 — Durable campaign model

- Campaign, goal revision, task, checkpoint, review packet, supervisor decision types.
- Per-repository campaign store with request-id deduplication and active/recent indexes.
- Explicit legal state transitions and optimistic revision checks.
- Runtime event ledger integration.

### Slice 2 — Isolated Campaign workspace and non-blocking reconciler

- Deterministic Campaign branch/worktree creation and checkout registration without switching the production checkout.
- Execution Workers honor the checkout identity recorded on every Job.
- Bounded active-campaign scanning.
- Dependency-aware task dispatch with per-campaign concurrency.
- Generic MCP operation support through existing ExecutionJob workers.
- Nested Agent Run tracking for `dispatch_task`/`retry_task_run` results.
- Bounded retry/backoff, independent failure progression, final acceptance checkpoint.

### Slice 3 — ChatGPT supervision surface

- MCP tools to create, inspect, pause/resume/cancel, add tasks, read review packets, and submit decisions.
- Checkpoint nonce and goal-revision validation.
- Pull, safe-operation, and built-in Workspace Agent supervisor modes; all triggers are non-blocking and pull review remains the default.
- Bounded packet size and evidence summaries.

### Slice 4 — Scheduler and projection integration

- Campaign ticks run outside the global dispatch reservation lock.
- Runtime projection includes compact campaign progress and pending-review counts.
- Scheduler health remains independent of supervisor availability.

### Slice 5 — Verification and delivery

- Unit tests for replay, idempotency, invalid transitions, stale review rejection, no duplicate dispatch, independent failure, retry bounds, worktree isolation, final human acceptance, and campaign concurrency.
- Controller V8, typecheck, focused runtime tests, and full test suite.
- Git patch series, unified patch, complete modified source archive, and implementation report.
