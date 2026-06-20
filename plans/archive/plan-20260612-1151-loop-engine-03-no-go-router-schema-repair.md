# Plan: Sprint task: loop-engine-03-no-go-router-schema-repair

> **Status**: Archived
> **Created**: 20260612-1151
> **Slug**: loop-engine-03-no-go-router-schema-repair
> **Planning Source**: repo-harness-sprint
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:tasks/sprints/20260612-0236-loop-engine.sprint.md#loop-engine-03-no-go-router-schema-repair
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md`
> **Sprint Review**: `tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md`
> **Implementation Notes**: `tasks/notes/20260612-1151-loop-engine-03-no-go-router-schema-repair.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-sprint planning output.
- Source ref: sprint:tasks/sprints/20260612-0236-loop-engine.sprint.md#loop-engine-03-no-go-router-schema-repair
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md`
- Sprint contract: `tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md`
- Sprint review: `tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md`
- Implementation notes: `tasks/notes/20260612-1151-loop-engine-03-no-go-router-schema-repair.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md`.

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
- Contract file: `tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md`
- Review file: `tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md`
- Implementation notes file: `tasks/notes/20260612-1151-loop-engine-03-no-go-router-schema-repair.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260612-1151-loop-engine-03-no-go-router-schema-repair.contract.md`, `tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md`, and `tasks/notes/20260612-1151-loop-engine-03-no-go-router-schema-repair.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260612-1151-loop-engine-03-no-go-router-schema-repair.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260612-1151-loop-engine-03-no-go-router-schema-repair.md`; after execution revert branch `codex/loop-engine-03-no-go-router-schema-repair` or the generated task artifacts

## Captured Planning Output

# Sprint Task: loop-engine-03-no-go-router-schema-repair

## Context

- Sprint: `tasks/sprints/20260612-0236-loop-engine.sprint.md`
- Backlog row: 3
- Mode: contract
- Read the sprint PRD and Architecture Notes before implementation.

## Goal

Deliver backlog task `loop-engine-03-no-go-router-schema-repair` so that the acceptance line holds: G1=no-go 前置;不做 shadow injection;修正 NL 决策表/route-nl-vs-ts 输出 schema 或 normalization,使 Claude+Codex 都能稳定产出受控 intent/action vocabulary;prompt-guard TS verdict 仍权威;rerun route-nl-vs-ts 后在 Execution Log 写二次 go/no-go,若仍 no-go 则把 Track A 收缩为显式触发集合

## Task Breakdown

- [x] Implement backlog task `loop-engine-03-no-go-router-schema-repair` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: G1=no-go 前置;不做 shadow injection;修正 NL 决策表/route-nl-vs-ts 输出 schema 或 normalization,使 Claude+Codex 都能稳定产出受控 intent/action vocabulary;prompt-guard TS verdict 仍权威;rerun route-nl-vs-ts 后在 Execution Log 写二次 go/no-go,若仍 no-go 则把 Track A 收缩为显式触发集合

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Implement backlog task `loop-engine-03-no-go-router-schema-repair` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: G1=no-go 前置;不做 shadow injection;修正 NL 决策表/route-nl-vs-ts 输出 schema 或 normalization,使 Claude+Codex 都能稳定产出受控 intent/action vocabulary;prompt-guard TS verdict 仍权威;rerun route-nl-vs-ts 后在 Execution Log 写二次 go/no-go,若仍 no-go 则把 Track A 收缩为显式触发集合
