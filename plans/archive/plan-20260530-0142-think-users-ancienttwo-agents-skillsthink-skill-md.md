# Plan: ExternalAcceptance review gate

> **Status**: Archived
> **Created**: 20260530-0142
> **Slug**: think-users-ancienttwo-agents-skillsthink-skill-md
> **Planning Source**: waza-think
> **Orchestration Kind**: waza-think
> **Source Ref**: think](/Users/ancienttwo/.agents/skillsthink/SKILL.md) 你来写详细方案
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
> **Sprint Review**: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
> **Implementation Notes**: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: think](/Users/ancienttwo/.agents/skillsthink/SKILL.md) 你来写详细方案
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260530-0142-think-users-ancienttwo-agents-skillsthink-skill-md.md`
- Sprint contract: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
- Sprint review: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
- Implementation notes: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260530-0142-think-users-ancienttwo-agents-skillsthink-skill-md.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260530-0142-think-users-ancienttwo-agents-skillsthink-skill-md.md`.

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
- Contract file: `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`
- Review file: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`
- Implementation notes file: `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260530-0142-think-users-ancienttwo-agents-skillsthink-skill-md.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/think-users-ancienttwo-agents-skillsthink-skill-md.contract.md`, `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md`, and `tasks/notes/think-users-ancienttwo-agents-skillsthink-skill-md.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/think-users-ancienttwo-agents-skillsthink-skill-md.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260530-0142-think-users-ancienttwo-agents-skillsthink-skill-md.md`; after execution revert branch `codex/think-users-ancienttwo-agents-skillsthink-skill-md` or the generated task artifacts

## Captured Planning Output

# ExternalAcceptance review gate

## Summary
实现“验收并行启动 + 完成前强门禁”。`/check`、验收、合并前、release follow-through 意图进入时，hook 输出 host-aware 的 ExternalAcceptance prompt，让主 agent 一边跑本地 `/check`，一边并行调用对方模型。Codex host 调 Claude，Claude host 调 Codex。`done` 和 `contract-worktree.sh finish` 前只检查当前 `tasks/reviews/<slug>.review.md` 是否记录通过的 external acceptance 结果。

## P1 / P2 / P3 Evidence
- P1 map: 真实边界是 `UserPromptSubmit -> prompt-guard.sh`、`workflow-state.sh` 的 review/check helper、`verify-sprint.sh` 的结构化 evidence、`contract-worktree.sh finish` 的最终 merge path。`tasks/contracts/*` 是承诺和 scope，`tasks/reviews/*` 是验收结论。
- P2 trace: 用户说“验收/提交/合并前”时，`prompt-guard.sh` 现在输出 `/check` 和 `[CrossReview]`；用户说 done 时，`prompt-guard.sh` 检查 contract、review pass、checks pass、task 全勾，然后 archive 或提示 finish；worktree finish 走 `verify-sprint -> scope -> archive -> commit -> ff-merge`。
- P3 decision: 不让 hook 自动跑 Claude/Codex。现有 Codex 非 SessionStart stdout 要静音，把网络/认证/长输出塞进 hook 热路径会破坏稳定性。改成“强指令 + 结果门禁”是最小一致变更。

## Building
实现 `ExternalAcceptance` 流水线：review/check 阶段并行启动外部验收；完成前 gate 验当前 review 文件有通过的外部验收记录。主 agent 负责实际调用 `/claude-review` 或 `codex-review` 并把结果写入 review 文件。

## Not Building
不新增新 hook route，不新增 daemon/job queue，不新增数据库或单独 evidence 文件，不修改 host adapter JSON，不在 shell hook 内直接执行 `claude -p` 或 `codex exec`，不把外部验收结果写回 `tasks/contracts/*`。

## Review Record Contract
外部结果落到当前 `tasks/reviews/<slug>.review.md`，固定 section:

```md
## External Acceptance Advice
> **External Acceptance**: pass
> **External Reviewer**: Claude|Codex
> **External Source**: claude-review|codex-review
> **External Started**: YYYY-MM-DDTHH:MM:SS+0800
> **External Completed**: YYYY-MM-DDTHH:MM:SS+0800

- P1 blockers: none
- P2 advisories: ...
- Acceptance checklist: pass
```

门禁规则：必须是 `External Acceptance: pass`；reviewer 必须与 host 相反；`P1 blockers` 不能有非 `none` 内容。CLI 缺失、timeout、auth/network fail 记录为 `External Acceptance: unavailable`，默认不放行；只有 `Manual Override:` 一行存在且写明理由时才放行。

## Implementation Changes
- Add `workflow_external_acceptance_expected_reviewer`, `workflow_external_acceptance_pass`, and status helpers to `.ai/hooks/lib/workflow-state.sh`; mirror to `assets/hooks/lib/workflow-state.sh`.
- Add `emit_external_acceptance_prompt review` to `.ai/hooks/prompt-guard.sh`; replace review/release `[CrossReview]` path with `[ExternalAcceptance]` prompt while keeping debug `[CrossReview]` advisory; mirror to `assets/hooks/prompt-guard.sh`.
- In done flow, check external acceptance after `workflow_review_recommends_pass` and before `workflow_checks_pass`.
- In `workflow_next_action()`, report `/check` as next action until external acceptance is recorded.
- In `scripts/contract-worktree.sh finish`, check external acceptance before `verify-sprint.sh` so direct finish cannot bypass the gate.
- In `scripts/verify-sprint.sh`, include `external_acceptance` status/source/reviewer in `.ai/harness/checks/latest.json`; do not replace the review file as the authority.
- Update docs/templates that describe `/check`, cross-review, finish, and generated workflow assets.

## Prompt Contract
`prompt-guard.sh` review intent output must include:
- Current active plan path if present.
- Current contract path if present.
- Current review path if derivable.
- Current checks file path.
- Current diff scope instructions: branch diff, staged, unstaged, untracked.
- Host-aware command: `HOOK_HOST=codex -> /claude-review`; otherwise `codex-review`.
- Instruction: do not run `/check`, do not edit files, only produce acceptance advice.
- Exact output format for `## External Acceptance Advice`.

## Task Breakdown
- [x] Capture this approved plan and start an isolated contract worktree.
- [x] Implement workflow-state external acceptance parser and gate helpers.
- [x] Emit host-aware ExternalAcceptance prompt from review/release intent.
- [x] Enforce external acceptance in done flow and contract-worktree finish.
- [x] Include external acceptance status in verify-sprint structured evidence.
- [x] Mirror hook/helper changes to assets and generated templates/docs.
- [x] Add targeted tests for prompt, parser, done gate, finish gate, and verify-sprint JSON.
- [x] Run targeted tests and required repo checks.

## Test Plan
- `bun test tests/hook-runtime.test.ts tests/helper-scripts.test.ts tests/workflow-state-lib.test.ts tests/hook-contracts.test.ts tests/bootstrap-files.test.ts`
- `bun test`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`

## Risk Controls
- Implement in an isolated `codex/external-acceptance-gate` style worktree because the primary worktree has unrelated dirty setup-plugin changes.
- Keep external model execution outside hooks; gate only on review evidence.
- Parse fixed blockquote markers only; do not infer pass from prose.
- Rollback is reverting this branch; no data migration or host adapter mutation.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Capture this approved plan and start an isolated contract worktree.
- [x] Implement workflow-state external acceptance parser and gate helpers.
- [x] Emit host-aware ExternalAcceptance prompt from review/release intent.
- [x] Enforce external acceptance in done flow and contract-worktree finish.
- [x] Include external acceptance status in verify-sprint structured evidence.
- [x] Mirror hook/helper changes to assets and generated templates/docs.
- [x] Add targeted tests for prompt, parser, done gate, finish gate, and verify-sprint JSON.
- [x] Run targeted tests and required repo checks.
