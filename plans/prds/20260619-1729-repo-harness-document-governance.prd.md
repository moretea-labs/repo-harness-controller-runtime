---
title: "Repo Harness 文档与规则治理"
kind: "prd"
created_at: "2026-06-19T09:29:52.308Z"
source: "repo-harness-mcp"
---
# Repo Harness 文档与规则治理

> **Status**: Draft

## Idea

整理 repo-harness 仓库中的规则、计划、Sprint、handoff、状态快照与历史证据，使当前执行状态可信、handoff 可移植、规则层级清晰、历史工件可追溯但不污染默认上下文。

## Problem

当前仓库存在 tasks/current.md 混入其他机器和旧 worktree 状态、codex-goal.md 使用不可移植绝对路径、resume 落后于 current handoff、latest.json 几乎为空、根级 plans 与 sprints 堆积大量过时或已完成工件、研究报告混入 PRD 目录、超长 Sprint 难以直接执行、AGENTS/CLAUDE/SKILL/reference-configs 规则入口可能重复、历史 MCP 材料混入 handoff 等问题。继续叠加文档会进一步降低当前状态可信度和执行效率。

## Users

- repo-harness 维护者
- 使用 Codex 执行仓库任务的开发者
- 使用 ChatGPT/repo-harness 进行规划和审查的用户

## Goals

- 恢复 tasks/current、handoff、checks 的可信状态
- 建立可移植的 Codex goal 与恢复包
- 明确 AGENTS、CLAUDE、SKILL、reference-configs 的单一规则源和镜像关系
- 归档 completed、canceled、superseded 的计划与 Sprint
- 将研究报告与正式 PRD 分离
- 为超长 Sprint 引入 active phase packet
- 让历史 contract/review/notes 可追溯但不进入默认执行上下文

## Non-goals

- 不删除有价值的历史证据
- 不把所有规则合并为单一超长文件
- 不重写 repo-harness 产品功能
- 不修改与文档治理无关的应用代码
- 不使用绝对路径作为新的长期合同

## Acceptance Criteria

- [ ] tasks/current.md 只反映当前仓库可验证状态
- [ ] codex-goal.md 不含其他用户或机器的绝对路径
- [ ] resume.md 与 current.md 保持一致且顺序正确
- [ ] latest.json 明确表达最近检查状态
- [ ] 根级 plans/sprints 只保留仍有效工件，其他进入 archive 或标记 superseded
- [ ] PRD 目录只包含正式 PRD
- [ ] AGENTS/CLAUDE 的 canonical/mirror 关系明确并可校验
- [ ] SKILL.md 不重复承载全部仓库规则
- [ ] handoff 目录只保留新会话必读文件
- [ ] workflow check 通过或仅剩明确外部环境警告

## Workflow Contract

- PRD is the source of product intent.
- Sprint must be generated as ordered checklist task cards.
- Codex execution must happen through a host-native `/goal` prompt or local Codex session, not through remote MCP execution.

## Handoff Notes

本 PRD 只处理 repo-harness 仓库自身文档治理。实际文件移动、重命名、镜像生成和状态刷新由本地 Codex 执行；ChatGPT 仅通过 repo-harness 准备规划与 handoff。
