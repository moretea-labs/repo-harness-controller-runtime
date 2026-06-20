# Plan: Architecture doc truth loop: queue engine, freshness gate, productization

> **Status**: Archived
> **Created**: 20260612-0255
> **Slug**: architecture-doc-truth-loop
> **Planning Source**: waza-think
> **Orchestration Kind**: waza-think
> **Source Ref**: Files mentioned by the user: ## Here is Claude's plan: ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md`
> **Sprint Review**: `tasks/reviews/20260612-0255-architecture-doc-truth-loop.review.md`
> **Implementation Notes**: `tasks/notes/20260612-0255-architecture-doc-truth-loop.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: Files mentioned by the user: ## Here is Claude's plan: ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260612-0255-architecture-doc-truth-loop.md`
- Sprint contract: `tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md`
- Sprint review: `tasks/reviews/20260612-0255-architecture-doc-truth-loop.review.md`
- Implementation notes: `tasks/notes/20260612-0255-architecture-doc-truth-loop.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260612-0255-architecture-doc-truth-loop.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260612-0255-architecture-doc-truth-loop.md`.

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
- Contract file: `tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md`
- Review file: `tasks/reviews/20260612-0255-architecture-doc-truth-loop.review.md`
- Implementation notes file: `tasks/notes/20260612-0255-architecture-doc-truth-loop.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260612-0255-architecture-doc-truth-loop.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260612-0255-architecture-doc-truth-loop.contract.md`, `tasks/reviews/20260612-0255-architecture-doc-truth-loop.review.md`, and `tasks/notes/20260612-0255-architecture-doc-truth-loop.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260612-0255-architecture-doc-truth-loop.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260612-0255-architecture-doc-truth-loop.md`; after execution revert branch `codex/architecture-doc-truth-loop` or the generated task artifacts

## Captured Planning Output

# Architecture doc truth loop:queue engine、freshness gate、productization

Full research report(格局判断 + 根因 + 完整设计): `docs/researches/20260612-architecture-doc-truth-loop.md`
Program sprint: `tasks/sprints/`(slug `architecture-doc-loop`;每行 backlog 任务经 `sprint-backlog.sh start-task --sprint <file>` 捕获自己的 slice plan)
External review: Codex(waza-think, 2026-06-12)背书终态并收紧执行,四个 delta 已并入:strict/check fail-closed、TS-first 分工、triage legacy cutoff、执行序位先于 loop-engine-01。

## 执行序位(Codex 建议,已采纳)

- 本 sprint 的 slices 在 isolated contract worktree 执行,**先于 `loop-engine-01`**(loop-engine 会继续改 hook/runtime 表面,先修 request queue 避免新 sprint 持续制造架构欠账)。
- 不改 `tasks/sprints/20260612-0236-loop-engine.sprint.md` 内容;active-sprint 标记仍指向 loop-engine,本 sprint 经 `sprint-backlog.sh start-task --sprint tasks/sprints/<本文件>` 显式覆盖操作。
- 不进 `tasks/todo.md`,不混入 primary worktree 的 dirty changes。

## Direction(已批准)

- **单一 queue CLI 拥有完整生命周期**:`scripts/architecture-queue.sh record|status|reindex|triage|check` 拥有 request/card/index 的完整契约;`scripts/architecture-drift.sh` 被吸收删除(detect/classify/event 逻辑并入 `record`)。调用链:host hook → `repo-harness-hook PostToolUse --route edit`(既有薄入口)→ `.ai/hooks/post-edit-guard.sh`(只编排)→ `architecture-queue.sh record --file <path>`。
- per-capability dirty card:`docs/architecture/requests/<capability_id>.md`,一 capability 最多一张卡,由文件系统结构保证;events.jsonl 保持完整 per-edit 审计流。
- `docs/architecture/index.md` 的 Pending 段降级为派生产物:`<!-- BEGIN/END ARCHITECTURE PENDING REQUESTS -->` 标记内由 `reindex` 全量重写;`reindex --check` 进 Required Checks。
- 切片关账门禁:`policy.architecture.freshness_gate = advisory` 出厂,跑满一个 slice 后 config-only 翻 `strict`;`off` 为一键回退。**PostToolUse 只记录 + advisory,永不硬拦;block 只发生在 `contract-worktree.sh finish` / `check-architecture-sync.sh`。**
- fail 语义(Codex 修正):advisory/off 缺依赖 fail-open + WARN;**strict 与 `check` 缺 queue/resolver 必须 fail-closed**。
- 实现分工(Codex 修正):shell 只做 orchestration;card merge、JSON parsing、deterministic rendering 进 `scripts/architecture-event.ts`(bun 缺失时 record 降级 WARN 跳过卡片更新,不做 bash 双实现;events.jsonl 仍由既有 bash 路径写入)。
- 同步产品化进 `assets/`:下游 init/migrate 获得同一闭环,下游默认 `advisory`;`architecture-drift.sh` 进下游 retired-removal 清单。
- 铁律保留:hooks 只记录 drift、永不写 module prose;agent 经 `repo-harness-architecture` 协议 author 后用 `archive-architecture-request.sh` 归档。
- 研究面迁移(用户补充的架构决策,2026-06-12):`docs/researches/*` 成为研究报告唯一权威面,`tasks/research.md` 退役为 tombstone 指针;ResearchGate 等所有引用面随 slice 4 迁移。

## 根因(已验证,详见 research report)

1. `architecture-drift.sh:456` 无锚点 append-to-EOF 写 index → index 尾部出现 `## Review Backlog` 后条目全部落错段(`## Pending Requests` 显示 "(none)",29 条含重复条目在错误章节)。
2. `prune_superseded_pending_lines`(L191)于 2026-06-10(a4ad852)引入,晚于 2026-05-28/29 的 backlog 形成;且只删 index 行、不归档 request 文件,违反 "requests/ pending-only" 不变量。
3. 并发 PostToolUse hook 在 grep-dedup(L455)与 append(L456)之间竞态 → 同秒重复行。

处置:删除 append+prune 状态机(不修复),换"扫目录、重写受控块"派生模型——竞态从 bug 变成幂等重写。

## Task Breakdown

- [ ] arch-doc-loop-01-queue-engine-triage — 新 `scripts/architecture-queue.sh`(**record**/status/reindex/triage/check;record 吸收 `architecture-drift.sh` 的 detect/classify/event 逻辑后将其删除)+ `.ai/hooks` 与 `assets/hooks` 两份 `post-edit-guard.sh` 改调 `architecture-queue.sh record`(保留 `[ArchitectureDrift] Request:` 输出前缀作为 hook grep 契约)+ `architecture-event.ts` 承载 card merge/JSON/渲染(新 `upsert-request` 等子命令)+ policy `architecture` 新键(freshness_gate/gate_min_severity/pending_block_begin/end/queue_script)+ `tests/architecture-queue.test.ts` 五组;真实 backlog 清账:`triage --before 2026-06-01`(legacy cutoff 护栏,新近 pending 列出不动)27→4 卡、27 条 Superseded 入 archive/2026/、agent resolve pass 后 requests/ 清零、根契约 pending marker 清除。
- [ ] arch-doc-loop-02-freshness-gate-surfaces — `contract-worktree.sh finish` 在 verify-sprint 前插 `check_architecture_freshness`(merge-base diff ∪ porcelain → `capability-resolver.ts match --paths-from -` 批量 → 与开卡求交;off/advisory/strict 三模式;strict 缺 queue/resolver fail-closed);新 `scripts/check-architecture-sync.sh` 进根 Required Checks + `package.json` 加 `check:architecture-sync` script(完整性恒硬失败、新鲜度仅 strict 硬失败);`.ai/hooks` 与 `assets/hooks` 两份 `session-start-context.sh` 同步加 drift 摘要行;更新 `repo-harness-architecture` SKILL 与 `docs/reference-configs/harness-overview.md`。
- [ ] arch-doc-loop-03-productize-assets — `assets/templates/helpers/` 镜像改动脚本 + 新增 `architecture-queue.sh`、`check-architecture-sync.sh`、**移除 `architecture-drift.sh` 并加入下游 retired-removal 清单**;workflow-contract 两份(assets v1 ↔ .ai/harness)`helpers.scripts`/`artifacts.requiredFiles` 同步且字节相等;`project-init-lib.sh` helper_names/chmod 表、下游 policy 模板(advisory)、seed index 加标记;scaffold-parity 快照更新;`check-task-workflow.sh` 增 check_required_file;`migrate-project-template.sh --repo . --dry-run` 通过。
- [ ] arch-doc-loop-04-research-surface-migration — 研究面契约从 `tasks/research.md` 迁到 `docs/researches/*`:改写全部活跃引用(ResearchGate hook 按 docs/researches/ 最新报告 mtime 判新鲜、`capture-plan.sh` 模板 Research 行、`check-task-sync.sh` 同步面、两份 workflow-contract requiredFiles、根 `CLAUDE.md`/`AGENTS.md`、`docs/reference-configs`、`project-init-lib.sh` seed 与下游模板);存量条目迁入 docs/researches/ 后 `tasks/research.md` 变 tombstone 指针并进下游 retired-removal 清单;grep 全仓除归档外无活跃旧引用;ResearchGate 新鲜/过期两态有验证。

## Key Constraints

- 调用链分层:host adapter 只触发 `repo-harness-hook`(既有薄入口,不冷启动 full commander CLI);repo-local hook 只编排,queue CLI 拥有 request/card/index 完整契约;hook 高频并发 30s timeout,禁止在 PostToolUse 做硬拦或重逻辑。
- stdout 契约保持:`[ArchitectureDrift] Request: <path>` 前缀继续由 `architecture-queue.sh record` 输出(`post-edit-guard.sh:47` grep 此前缀触发 contract-sync 链;两侧同 slice 更新但保留前缀最小化爆炸半径)。
- `archive-architecture-request.sh` 零改动复用(只解析 `> **Status**:` 行;归档重名自动加时间戳前缀)。
- triage 护栏:只自动 supersede `--before <cutoff>` 之前的 legacy 债;新近真实 pending 必须保留或单独 resolve,禁止盲目合并。
- 顺序硬约束:slice 3 之前不得对本仓库跑 `migrate-project-template.sh --apply`(旧 `assets/templates/helpers/` 会覆盖新 `scripts/`);hooks 字节 parity 测试把 post-edit-guard 镜像锁进 slice 1、session-start 镜像锁进 slice 2。
- 不抽 `scripts/lib/architecture-lib.sh` 共享库(`pi_install_helpers` 只装平铺文件);不新增 service 或后台 daemon。
- 范围外:domains/ 重组、无人值守自动写 prose、架构文档自动进 gbrain、snapshots/diagrams 流程变更、loop-engine sprint 内容变更。
- 新外部依赖:无;无 API key。

## Rollback

- 门禁:`freshness_gate:"off"` config-only 回退,无需回滚代码。
- triage/归档产物全部 git 跟踪;每 slice 经 contract worktree 原子合入,`git revert` 可整体回退。
- 运行时降级:resolver 不可用门禁 fail-open + WARN;queue 脚本缺失 record 仅 WARN,不阻塞 hook、不退回盲 append。

## Verification

每 slice 收口跑根 Required Checks:

```bash
bun test
bash scripts/check-deploy-sql-order.sh
bash scripts/check-task-sync.sh
bash scripts/check-task-workflow.sh --strict
bun scripts/inspect-project-state.ts --repo . --format text
bash scripts/migrate-project-template.sh --repo . --dry-run
```

Slice 1 额外 proof point(真实 backlog):

```bash
bash scripts/architecture-queue.sh status                    # 27 legacy → 4 capability 分组
bash scripts/architecture-queue.sh triage --before 2026-06-01 # 4 卡;27 条 Superseded;index 自愈;新近 pending 不动
bash scripts/architecture-queue.sh reindex --check           # exit 0
# agent resolve pass:刷 3 个 module 文档 + 归档 4 卡
ls docs/architecture/requests/*.md                 # 清零
```

Slice 2 额外:脚本化 worktree 在 advisory 与 strict 两档各走一次 finish(警告/阻断各验证一次)。
Slice 3 额外:/tmp 全新 scaffold 验证下游骨架带标记 index、advisory policy、两个新脚本。

## Success Criteria

1. 真实 backlog 清零且 `reindex --check` 持续通过(进 Required Checks)。
2. index 受控块与 requests/ 目录扫描恒一致(测试锁定)。
3. advisory 跑满一个 slice 后警告信噪比足以支持翻 strict(否则触发 falsifier,改道而非硬上)。
4. 下游新 scaffold 自带闭环(scaffold-parity 锁定)。

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] arch-doc-loop-01-queue-engine-triage — 新 `scripts/architecture-queue.sh`(**record**/status/reindex/triage/check;record 吸收 `architecture-drift.sh` 的 detect/classify/event 逻辑后将其删除)+ `.ai/hooks` 与 `assets/hooks` 两份 `post-edit-guard.sh` 改调 `architecture-queue.sh record`(保留 `[ArchitectureDrift] Request:` 输出前缀作为 hook grep 契约)+ `architecture-event.ts` 承载 card merge/JSON/渲染(新 `upsert-request` 等子命令)+ policy `architecture` 新键(freshness_gate/gate_min_severity/pending_block_begin/end/queue_script)+ `tests/architecture-queue.test.ts` 五组;真实 backlog 清账:`triage --before 2026-06-01`(legacy cutoff 护栏,新近 pending 列出不动)27→4 卡、27 条 Superseded 入 archive/2026/、agent resolve pass 后 requests/ 清零、根契约 pending marker 清除。
- [ ] arch-doc-loop-02-freshness-gate-surfaces — `contract-worktree.sh finish` 在 verify-sprint 前插 `check_architecture_freshness`(merge-base diff ∪ porcelain → `capability-resolver.ts match --paths-from -` 批量 → 与开卡求交;off/advisory/strict 三模式;strict 缺 queue/resolver fail-closed);新 `scripts/check-architecture-sync.sh` 进根 Required Checks + `package.json` 加 `check:architecture-sync` script(完整性恒硬失败、新鲜度仅 strict 硬失败);`.ai/hooks` 与 `assets/hooks` 两份 `session-start-context.sh` 同步加 drift 摘要行;更新 `repo-harness-architecture` SKILL 与 `docs/reference-configs/harness-overview.md`。
- [ ] arch-doc-loop-03-productize-assets — `assets/templates/helpers/` 镜像改动脚本 + 新增 `architecture-queue.sh`、`check-architecture-sync.sh`、**移除 `architecture-drift.sh` 并加入下游 retired-removal 清单**;workflow-contract 两份(assets v1 ↔ .ai/harness)`helpers.scripts`/`artifacts.requiredFiles` 同步且字节相等;`project-init-lib.sh` helper_names/chmod 表、下游 policy 模板(advisory)、seed index 加标记;scaffold-parity 快照更新;`check-task-workflow.sh` 增 check_required_file;`migrate-project-template.sh --repo . --dry-run` 通过。
- [ ] arch-doc-loop-04-research-surface-migration — 研究面契约从 `tasks/research.md` 迁到 `docs/researches/*`:改写全部活跃引用(ResearchGate hook 按 docs/researches/ 最新报告 mtime 判新鲜、`capture-plan.sh` 模板 Research 行、`check-task-sync.sh` 同步面、两份 workflow-contract requiredFiles、根 `CLAUDE.md`/`AGENTS.md`、`docs/reference-configs`、`project-init-lib.sh` seed 与下游模板);存量条目迁入 docs/researches/ 后 `tasks/research.md` 变 tombstone 指针并进下游 retired-removal 清单;grep 全仓除归档外无活跃旧引用;ResearchGate 新鲜/过期两态有验证。
