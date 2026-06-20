# Plan: Sprint task: arch-doc-loop-01-queue-engine-triage

> **Status**: Archived
> **Created**: 20260612-0318
> **Slug**: arch-doc-loop-01-queue-engine-triage
> **Planning Source**: repo-harness-sprint
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:tasks/sprints/20260612-0256-architecture-doc-loop.sprint.md#arch-doc-loop-01-queue-engine-triage
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md`
> **Sprint Review**: `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md`
> **Implementation Notes**: `tasks/notes/20260612-0318-arch-doc-loop-01-queue-engine-triage.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-sprint planning output.
- Source ref: sprint:tasks/sprints/20260612-0256-architecture-doc-loop.sprint.md#arch-doc-loop-01-queue-engine-triage
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md`
- Sprint contract: `tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md`
- Sprint review: `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md`
- Implementation notes: `tasks/notes/20260612-0318-arch-doc-loop-01-queue-engine-triage.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md`
- Review file: `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md`
- Implementation notes file: `tasks/notes/20260612-0318-arch-doc-loop-01-queue-engine-triage.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260612-0318-arch-doc-loop-01-queue-engine-triage.contract.md`, `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md`, and `tasks/notes/20260612-0318-arch-doc-loop-01-queue-engine-triage.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260612-0318-arch-doc-loop-01-queue-engine-triage.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260612-0318-arch-doc-loop-01-queue-engine-triage.md`; after execution revert branch `codex/arch-doc-loop-01-queue-engine-triage` or the generated task artifacts

## Captured Planning Output

# Sprint Task: arch-doc-loop-01-queue-engine-triage

## Context

- Sprint: `tasks/sprints/20260612-0256-architecture-doc-loop.sprint.md`
- Backlog row: 1
- Mode: contract
- Read the sprint PRD and Architecture Notes before implementation.

## Goal

Deliver backlog task `arch-doc-loop-01-queue-engine-triage` so that the acceptance line holds: new `scripts/architecture-queue.sh` owns record/status/reindex/triage/check; record absorbs architecture-drift behavior and preserves `[ArchitectureDrift] Request:` output; post-edit hooks call queue record; policy adds advisory freshness keys; architecture queue tests cover merge, reindex, triage cutoff, gate modes, and archive roundtrip; legacy pre-2026-06-01 backlog is triaged and resolved; required checks pass.

## Task Breakdown

- [x] Implement backlog task `arch-doc-loop-01-queue-engine-triage` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: queue engine behavior, hook parity, policy keys, tests, real legacy triage cleanup, and required checks

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Implement backlog task `arch-doc-loop-01-queue-engine-triage` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: queue engine behavior, hook parity, policy keys, tests, real legacy triage cleanup, and required checks
