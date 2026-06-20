# Plan: Sprint task: loop-engine-02-routing-ab-eval

> **Status**: Archived
> **Created**: 20260612-0350
> **Slug**: loop-engine-02-routing-ab-eval
> **Planning Source**: repo-harness-sprint
> **Orchestration Kind**: sprint-task
> **Source Ref**: sprint:tasks/sprints/20260612-0236-loop-engine.sprint.md#loop-engine-02-routing-ab-eval
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md`
> **Sprint Review**: `tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md`
> **Implementation Notes**: `tasks/notes/20260612-0350-loop-engine-02-routing-ab-eval.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-sprint planning output.
- Source ref: sprint:tasks/sprints/20260612-0236-loop-engine.sprint.md#loop-engine-02-routing-ab-eval
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md`
- Sprint contract: `tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md`
- Sprint review: `tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md`
- Implementation notes: `tasks/notes/20260612-0350-loop-engine-02-routing-ab-eval.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md`.

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
- Contract file: `tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md`
- Review file: `tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md`
- Implementation notes file: `tasks/notes/20260612-0350-loop-engine-02-routing-ab-eval.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260612-0350-loop-engine-02-routing-ab-eval.contract.md`, `tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md`, and `tasks/notes/20260612-0350-loop-engine-02-routing-ab-eval.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260612-0350-loop-engine-02-routing-ab-eval.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260612-0350-loop-engine-02-routing-ab-eval.md`; after execution revert branch `codex/loop-engine-02-routing-ab-eval` or the generated task artifacts

## Captured Planning Output

# Sprint Task: loop-engine-02-routing-ab-eval

## Context

- Sprint: `tasks/sprints/20260612-0236-loop-engine.sprint.md`
- Backlog row: 2
- Mode: contract
- Read the sprint PRD and Architecture Notes before implementation.

## Goal

Deliver backlog task `loop-engine-02-routing-ab-eval` so that the acceptance line holds: benchmark:skills 新增 route-nl-vs-ts eval(场景含 lessons.md 三个历史误报案例),A 臂 TS verdict、B 臂快照+NL 表自路由,在 Claude+Codex 各跑一轮非 dry-run;合规率/误报/token 增量报告落盘 .ai/harness/runs/,go/no-go 结论写入本文件 Execution Log

## Task Breakdown

- [x] Implement backlog task `loop-engine-02-routing-ab-eval` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: benchmark:skills 新增 route-nl-vs-ts eval(场景含 lessons.md 三个历史误报案例),A 臂 TS verdict、B 臂快照+NL 表自路由,在 Claude+Codex 各跑一轮非 dry-run;合规率/误报/token 增量报告落盘 .ai/harness/runs/,go/no-go 结论写入本文件 Execution Log

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Implement backlog task `loop-engine-02-routing-ab-eval` per the sprint PRD and Architecture Notes
- [x] Verify acceptance: benchmark:skills 新增 route-nl-vs-ts eval(场景含 lessons.md 三个历史误报案例),A 臂 TS verdict、B 臂快照+NL 表自路由,在 Claude+Codex 各跑一轮非 dry-run;合规率/误报/token 增量报告落盘 .ai/harness/runs/,go/no-go 结论写入本文件 Execution Log

## Execution Log

| When | Event | Result |
|------|-------|--------|
| 2026-06-12 03:59 | Implemented `route-nl-vs-ts` eval harness | Added `scripts/route-nl-vs-ts-eval.ts`, `evals/fixtures/route-nl-vs-ts/`, eval manifest entry `route-nl-vs-ts`, and focused tests. |
| 2026-06-12 04:04 | Codex with_skill non-dry-run | `iteration-20260612-040450-route-nl-vs-ts-codex`: status success, graders 14/14 passed, report `go`, TS compliance 100%, NL compliance 100%, false positives 0, false negatives 0, estimated token delta 1132. |
| 2026-06-12 04:10 | Claude with_skill non-dry-run | First benchmark attempt produced no artifacts before termination; follow-up Claude smoke returned `You've hit your session limit · resets 7am (Asia/Singapore)`. Acceptance remains open until Claude can be rerun. |
| 2026-06-12 04:26 | Owner override | User instructed: "在这个Goal里，跳过Claude验证，继续". Row 2 accepts Codex with_skill evidence and records Claude as skipped, not passed. |
