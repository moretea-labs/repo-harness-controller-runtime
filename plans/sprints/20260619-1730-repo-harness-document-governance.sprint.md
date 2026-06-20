---
title: "Repo Harness 文档治理 Sprint"
kind: "sprint"
created_at: "2026-06-19T09:30:21.441Z"
source: "repo-harness-mcp"
---
# Repo Harness 文档治理 Sprint

> **Status**: Draft

## Source

- PRD: `plans/prds/20260619-1729-repo-harness-document-governance.prd.md`

## Execution Rule

- Execute task cards in order.
- Keep each task card reviewable as one staged slice.
- After every completed phase, update the checklist and stage the result before continuing.
- Do not treat unstaged work as a completed phase.

## Checklist

### Task Card 1: 修复当前状态与 Handoff

- [ ] Objective: 清理 tasks/current.md 中不可验证的外部 worktree 和旧执行状态；重建可移植的 codex-goal、current handoff、resume 和 latest checks。严格按 current → goal → resume 的顺序更新，避免恢复包再次落后。
- [ ] Files/entrypoints: `tasks/current.md`, `.ai/harness/handoff/current.md`, `.ai/harness/handoff/codex-goal.md`, `.ai/harness/handoff/resume.md`, `.ai/harness/checks/latest.json`
- [ ] Verification: `tasks/current.md 不引用其他用户或机器路径`, `Active Plan / Sprint / Workstream 状态互相一致`, `codex-goal.md 只使用仓库相对路径或明确配置项`, `latest.json 明确表达 pass/fail/not_run`, `resume.md 时间不早于 current.md`
- [ ] Stage gate: run_workflow_check 不再报告 resume 落后于 current；当前状态和 goal 可由新会话直接执行。

### Task Card 2: 整理 Plans、PRDs 与 Sprints

- [ ] Objective: 审计根级 plans、plans/prds、plans/sprints 和 plans/archive。将 completed、canceled、superseded 或纯历史工件归档；把研究报告移出 PRD 目录；统一 Sprint 命名；为仍有效的超长 Sprint 标记总体规划并拆出当前 phase packet。
- [ ] Files/entrypoints: `plans/`, `plans/prds/`, `plans/sprints/`, `plans/archive/`
- [ ] Verification: `根级 plans 不再堆积明显已完成工件`, `PRD 目录只包含正式 PRD`, `旧版与 v2 计划有明确 superseded 关系`, `Sprint 文件名符合 YYYYMMDD-slug.sprint.md`, `超长 Sprint 不再作为默认全量执行入口`
- [ ] Stage gate: list_prds/list_sprints 返回的项目均可解释为正式且仍有效，归档和当前执行边界清晰。

### Task Card 3: 收敛规则层级

- [ ] Objective: 确定 AGENTS/CLAUDE 的 canonical 与 compatibility mirror 关系；明确 SKILL.md 只负责技能触发、命令与输入输出；reference-configs 承载详细协议和示例。删除重复规则正文或改为引用，给生成镜像增加禁止直接编辑标记。
- [ ] Files/entrypoints: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `docs/reference-configs/AGENTS.md`, `docs/reference-configs/CLAUDE.md`, `docs/reference-configs/global-working-rules.md`, `docs/reference-configs/agentic-development-flow.md`, `docs/reference-configs/sprint-contracts.md`, `docs/reference-configs/handoff-protocol.md`
- [ ] Verification: `同一强制规则只有一个 canonical source`, `CLAUDE/AGENTS 镜像关系明确`, `SKILL.md 不复制完整工程治理规则`, `reference-configs 的 stub/pointer 文件有清晰标记`, `context map 不默认加载大量重复规则`
- [ ] Stage gate: 新维护者能从一个入口判断规则优先级，不需要在多个文件间比对同一条规则。

### Task Card 4: 整理 Handoff、Evidence 与任务历史

- [ ] Objective: 将 mcp discovery、e2e result、sprint closeout 等长期材料移出 handoff；为 tasks/contracts、reviews、notes 建立关系说明与索引；历史资料保留但退出默认上下文。
- [ ] Files/entrypoints: `.ai/harness/handoff/`, `docs/evidence/`, `tasks/contracts/`, `tasks/reviews/`, `tasks/notes/`, `tasks/README.md`
- [ ] Verification: `handoff 目录只保留新会话必读文件`, `历史 MCP 材料进入 evidence 或 notes`, `tasks/README.md 说明 Plan → Contract → Review → Notes`, `默认上下文不会全量加载历史 notes/reviews/contracts`
- [ ] Stage gate: latest_handoff 只返回当前交接面；历史证据仍可通过索引追溯。

### Task Card 5: 验证与收口

- [ ] Objective: 运行严格工作流检查，验证链接、状态、命名、handoff 新鲜度和归档边界；更新 PRD/Sprint 执行记录并生成新的恢复包。
- [ ] Files/entrypoints: `plans/prds/20260619-1729-repo-harness-document-governance.prd.md`, `plans/sprints/`, `tasks/current.md`, `.ai/harness/handoff/`, `.ai/harness/checks/`
- [ ] Verification: `run_workflow_check 通过或仅剩外部 vault 警告`, `无失效相对链接`, `无不可移植绝对路径`, `当前状态、goal、resume 一致`, `治理结果有简洁 closeout 记录`
- [ ] Stage gate: 新会话只需读取 AGENTS.md、tasks/current.md、current handoff、codex-goal 和 latest checks 即可准确继续。

## Final Acceptance

- [ ] All task cards are checked.
- [ ] Required checks pass.
- [ ] Handoff explains staged state, residual risks, and next bottleneck if any.
