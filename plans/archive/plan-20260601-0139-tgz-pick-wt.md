# Plan: Dirty Merged WT Closeout Guard

> **Status**: Archived
> **Created**: 20260601-0139
> **Slug**: tgz-pick-wt
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: repo-harness-plan
> **Source Ref**: 你不应该存 tgz呀，合并是pick有用的，然后删无用的，你打包有什么用？ 是不是脚本有问题？ 因为我都是用WT开发新功能，你把这些功能备份了，我做来有什么用？
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260601-0139-tgz-pick-wt.contract.md`
> **Sprint Review**: `tasks/reviews/20260601-0139-tgz-pick-wt.review.md`
> **Implementation Notes**: `tasks/notes/20260601-0139-tgz-pick-wt.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: 你不应该存 tgz呀，合并是pick有用的，然后删无用的，你打包有什么用？ 是不是脚本有问题？ 因为我都是用WT开发新功能，你把这些功能备份了，我做来有什么用？
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260601-0139-tgz-pick-wt.md`
- Sprint contract: `tasks/contracts/20260601-0139-tgz-pick-wt.contract.md`
- Sprint review: `tasks/reviews/20260601-0139-tgz-pick-wt.review.md`
- Implementation notes: `tasks/notes/20260601-0139-tgz-pick-wt.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260601-0139-tgz-pick-wt.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260601-0139-tgz-pick-wt.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260601-0139-tgz-pick-wt.md`.

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
- Contract file: `tasks/contracts/20260601-0139-tgz-pick-wt.contract.md`
- Review file: `tasks/reviews/20260601-0139-tgz-pick-wt.review.md`
- Implementation notes file: `tasks/notes/20260601-0139-tgz-pick-wt.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260601-0139-tgz-pick-wt.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260601-0139-tgz-pick-wt.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260601-0139-tgz-pick-wt.contract.md`, `tasks/reviews/20260601-0139-tgz-pick-wt.review.md`, and `tasks/notes/20260601-0139-tgz-pick-wt.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260601-0139-tgz-pick-wt.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260601-0139-tgz-pick-wt.md`; after execution revert branch `codex/tgz-pick-wt` or the generated task artifacts

## Captured Planning Output

## Approved design summary
- Building: dirty merged WT closeout guard for repo-harness shipping and cleanup.
- Root cause: a one-off cleanup shell confused branch ancestry with dirty worktree content being merged, archived untracked files as tgz, then reset/cleaned linked worktrees.
- Product boundary: tracked cleanup already refuses dirty linked worktrees; the missing product path is official handling for merged branches whose linked worktree still has local deltas.
- Verification: focused helper-script tests plus workflow checks relevant to changed scripts.

## P1 Map
- Components: scripts/ship-worktrees.sh orchestrates PR/local/cleanup closeout; scripts/contract-worktree.sh owns finish and cleanup safety; assets/skill-commands/repo-harness-ship/SKILL.md documents the operator contract; tests/helper-scripts.test.ts exercises helper workflows in temporary git repositories.
- Entrypoint: maintainer runs scripts/ship-worktrees.sh --cleanup-merged from the target primary worktree after main contains a codex/* branch.
- Authority: git branch ancestry proves committed branch content is in target; linked worktree porcelain status proves local uncommitted/unstaged/untracked deltas are still outside main.
- Out of scope: no recovery of old archives in this slice; recovered deltas are already tracked in tasks/notes/recovered-linked-worktrees.notes.md.

## P2 Trace
- Path: scripts/ship-worktrees.sh --cleanup-merged lists codex/* linked worktrees, checks merge-base --is-ancestor branch target, then delegates to scripts/contract-worktree.sh cleanup.
- Failure pressure: cleanup refuses dirty worktrees, but ship output does not explain that this is a must-pick/must-discard state, so an agent may bypass it with reset/clean.
- New path: cleanup-merged must inspect dirty merged linked worktrees before delegation, classify the state, print actionable pick/discard guidance, and only run cleanup when the worktree is clean or the caller explicitly discards scaffold-only changes.

## P3 Decision Rationale
- Preserve invariant: tgz archives are not a successful closeout artifact; useful deltas must be committed/picked/applied or deliberately discarded when scaffold-only.
- Smallest coherent change: add guard functions to ship-worktrees, expose one explicit discard cleanup flag for scaffold-only merged worktrees, keep contract-worktree cleanup conservative.
- Tradeoff: do not auto-pick diffs because the script cannot know product intent; it can make unsafe cleanup impossible and make intentional discard explicit.
- 10x scale: branch ancestry remains cheap; status classification is per worktree and fails before destructive cleanup.

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| scripts/ship-worktrees.sh | Modify | Add dirty merged worktree guard and explicit scaffold-discard path for cleanup-merged. |
| scripts/contract-worktree.sh | Modify | Keep dirty refusal, improve message if needed; no automatic tgz/reset/clean. |
| tests/helper-scripts.test.ts | Modify | Add regression coverage for dirty merged worktree cleanup refusal and explicit scaffold discard. |
| assets/skill-commands/repo-harness-ship/SKILL.md | Modify | Document that dirty merged worktrees require pick/apply/commit or explicit scaffold discard, never tgz closeout. |
| tasks/notes/20260601-0139-tgz-pick-wt.notes.md | Modify | Record design decision and tradeoff. |

## Evidence Contract
- **State/progress path**: plans/plan-20260601-0139-tgz-pick-wt.md and tasks/notes/20260601-0139-tgz-pick-wt.notes.md
- **Verification evidence**: bun test tests/helper-scripts.test.ts; bash scripts/check-task-sync.sh; bash scripts/check-task-workflow.sh --strict when feasible
- **Evaluator rubric**: dirty merged linked WT cannot be silently cleaned; explicit discard path is bounded to scaffold-only files; no tgz/reset/clean as closeout
- **Stop condition**: focused tests pass or failure is traced to unrelated environment state
- **Rollback surface**: revert changes to ship/cleanup scripts, helper tests, skill command doc, and plan notes

## Task Breakdown
- [x] Add dirty merged linked worktree status inspection to ship cleanup path.
- [x] Add explicit scaffold-only discard cleanup mode without archiving tgz.
- [x] Add helper tests for refusal and intentional discard.
- [x] Update repo-harness-ship guidance and implementation notes.
- [x] Run focused verification.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->
