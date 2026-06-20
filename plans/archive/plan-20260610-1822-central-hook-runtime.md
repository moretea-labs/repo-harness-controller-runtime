# Plan: Central hook runtime resolution

> **Status**: Archived
> **Created**: 20260610-1822
> **Slug**: central-hook-runtime
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260610-1822-central-hook-runtime.contract.md`
> **Sprint Review**: `tasks/reviews/20260610-1822-central-hook-runtime.review.md`
> **Implementation Notes**: `tasks/notes/20260610-1822-central-hook-runtime.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260610-1822-central-hook-runtime.md`
- Sprint contract: `tasks/contracts/20260610-1822-central-hook-runtime.contract.md`
- Sprint review: `tasks/reviews/20260610-1822-central-hook-runtime.review.md`
- Implementation notes: `tasks/notes/20260610-1822-central-hook-runtime.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260610-1822-central-hook-runtime.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260610-1822-central-hook-runtime.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260610-1822-central-hook-runtime.md`.

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
- Contract file: `tasks/contracts/20260610-1822-central-hook-runtime.contract.md`
- Review file: `tasks/reviews/20260610-1822-central-hook-runtime.review.md`
- Implementation notes file: `tasks/notes/20260610-1822-central-hook-runtime.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260610-1822-central-hook-runtime.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260610-1822-central-hook-runtime.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260610-1822-central-hook-runtime.contract.md`, `tasks/reviews/20260610-1822-central-hook-runtime.review.md`, and `tasks/notes/20260610-1822-central-hook-runtime.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260610-1822-central-hook-runtime.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260610-1822-central-hook-runtime.md`; after execution revert branch `codex/central-hook-runtime` or the generated task artifacts

## Captured Planning Output

# 中央 Hook 运行时解析（central-first hook runtime）

## Context

用户在 97app（plan mode）被旧版 vendored `prompt-guard.sh` 硬阻断后指出根本问题：hook 的 host 接线是 user level（`~/.claude/settings.json` / `~/.codex/hooks.json` → `~/.repo-harness/hook-shim.sh`），但 hook 实现却 vendored 在每个 repo 的 `.ai/hooks/`，导致每次框架修复都要逐 repo 刷新（当前 fleet 中 8 个 repo 仍是 d57df59 之前的 blocking 版本）。要求从根本上解决：**一处更新，全 fleet 生效，不逐项目刷新**。

## P1 架构图

- 入口链 A（现役）：host event → user-level 配置 → `bash ~/.repo-harness/hook-shim.sh <hook>.sh` → opt-in/trust gate → `exec <repo>/.ai/hooks/run-hook.sh` → **repo vendored hook**。
- 入口链 B（Phase 1 CLI，已建未启用）：`repo-harness-hook <event> --route <route>`（`src/cli/installer/managed-entries.ts:37`）→ `src/cli/hook/runtime.ts runHook()` → `hooksDir = <repo>/.ai/hooks`（runtime.ts:115）→ **同样 repo vendored**。
- npm 包 `repo-harness@0.2.4` 已全局安装（`~/.bun/bin/repo-harness{,-hook}`），`package.json files` 已打包 `assets/`（含 `assets/hooks/` 全套 hook 源）与 `scripts/`。
- 双份模板：`assets/hooks/`（产品源）↔ `.ai/hooks/`（self-host 安装副本），当前同步；hook 修改必须双份落地。
- 结论：两条链的 dispatch 都已中央化，唯独 **hook 脚本解析点** 钉死在 repo 内——这就是 fleet drift 的根。

## P2 已追踪关键路径（本次事故）

97app UserPromptSubmit → 旧 shim（6/4 安装，无 trust gate）→ `97app/.ai/hooks/run-hook.sh` → 旧 `prompt-guard.sh`（≤5.2.1）→ 正则 `(implement|...|实现|...)` 命中"完全实现了parity" → implement intent → 无 `.ai/harness/active-plan` → `plan_status_no_active_block` → `hook_structured_error` + exit 2 硬阻断。agentic-dev 今日 d57df59 已改 advisory，但 97app 的 vendored 副本不随之更新。

## P3 设计判断

- 保留的 invariant：opt-in marker 语义、trust gate（Slice1 P0-1 安全决策）、`HOOK_REPO_ROOT` + cwd=repo 契约、Codex stdout 过滤、hook 调用 repo 内 `scripts/*.sh` helpers 的 `[ -x ]` 降级模式（容忍 hooks 与 repo scripts 的版本斜率）。
- 取舍：中央副本默认生效（满足"一处更新"），repo vendored 副本降级为「显式 pin 或回退」而非删除——init/migrate 继续 vendoring，保证无 repo-harness 环境的自包含性与 self-host 开发回路。不引入新抽象，只翻转解析顺序。
- 10x 规模下先崩的点：中央 hooks 与某 repo 旧 scripts/ 的斜率 → 已有 `[ -x ]` 守卫 + doctor 显式报告 active source 兜底。

## 设计：hook 脚本解析顺序（两条链一致）

1. env `REPO_HARNESS_HOOK_SOURCE`（`repo` | `central` | 绝对路径，调试/测试用）
2. repo pin：`.ai/harness/policy.json` 顶层 `"hook_source": "repo"`（self-host agentic-dev 设置此 pin，保证 hook 开发用工作区副本）
3. 中央副本：bash 链 `~/.repo-harness/hooks/`（`REPO_HARNESS_HOME` 可重定向，含 `.version` 戳）；CLI 链 `<packageRoot>/assets/hooks`（随 npm 包版本锁定）
4. 回退：`<repo>/.ai/hooks`（中央副本缺失时，兼容旧安装）

`run-hook.sh` 改为以自身所在目录解析 hook（`$SCRIPT_DIR/$HOOK_NAME`），REPO_ROOT 解析 `HOOK_REPO_ROOT` → `git rev-parse` → vendored `../..` 兜底，central 场景禁止落到 `$HOME`。`repo-harness.sh install` 新增 hooks bundle 安装（清空重建 `~/.repo-harness/hooks/`，复制 `assets/hooks/*.sh` + `lib/`，写 `.version`）；`status`/`doctor` 报告 active hook source 与版本。

## 文件清单

`scripts/hook-shim.sh`、`scripts/repo-harness.sh`、`assets/hooks/run-hook.sh` + `.ai/hooks/run-hook.sh`（双份）、`src/cli/hook/runtime.ts`、`src/cli/commands/doctor.ts`、`.ai/harness/policy.json`（self-host pin）、`docs/reference-configs/hook-operations.md` + `assets/reference-configs/hook-operations.md`（双份）、根 `CLAUDE.md`/`AGENTS.md` hook 实现定位行、测试见验证节。

## 执行切片

1. **Slice 1 — bash 链 central-first**：hook-shim.sh 解析顺序翻转 + run-hook.sh 自相对解析（双份）+ repo-harness.sh `install` 装 hooks bundle/`.version` + `status` 报告 active source；tests/hook-shim-trust.test.ts 扩展（central 优先、pin 生效、bundle 缺失回退、untrusted 不变）。
2. **Slice 2 — CLI 链 central-first**：runtime.ts `resolveHooksDir()`（env → pin → packaged assets/hooks → repo 回退）+ missing-script 提示按 source 措辞 + doctor 报告 hook runtime source/version；tests/hook-runtime.test.ts 解析用例。
3. **Slice 3 — pin、文档与 fleet 上线**：self-host policy pin；hook-operations.md 架构与 rollout 章节（双份）；根 CLAUDE.md/AGENTS.md 行更新；执行 `repo-harness.sh install --target both` 刷新 shim+bundle，trust 既有 fleet（~/Projects 下 opt-in repos），97app 重放原事故 prompt 验证 advisory 放行；required checks 全绿。

## 验证

- `bun test`（含新增解析用例）+ 全部 required checks + `migrate-project-template.sh --repo . --dry-run` self-migration。
- 端到端：以 97app 为 cwd、原事故 prompt 构造 stdin，经新 shim 跑 `prompt-guard.sh`，断言 exit 0 且输出含 `[PlanStatusGuard] Advisory`；agentic-dev（pinned）确认仍跑工作区副本。
- 安装幂等：temp-HOME `install --target both` 两次，bundle 与 `.version` 稳定。

## 回滚

revert 分支 `codex/central-hook-runtime`；运行态回滚 = 重跑旧版 `repo-harness.sh install`（shim 恢复 repo-local 委派）+ 删除 `~/.repo-harness/hooks/`。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [x] Slice 1: bash 链 central-first（hook-shim.sh + run-hook.sh 双份 + repo-harness.sh bundle install/status + shim 解析测试）
- [x] Slice 2: CLI 链 central-first（runtime.ts resolveHooksDir + doctor 报告 + hook-runtime 解析测试）
- [x] Slice 3: self-host pin + 文档双份 + 根契约行 + required checks（install/trust fleet 上线与 97app 事故重放在合并回 main 后执行，属运行态 rollout）
