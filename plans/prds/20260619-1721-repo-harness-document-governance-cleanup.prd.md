---
title: "Repo Harness 文档治理收敛"
kind: "prd"
created_at: "2026-06-19T09:21:27.993Z"
source: "repo-harness-mcp"
---
# Repo Harness 文档治理收敛

> **Status**: Draft

## Idea

整理 repo-harness 仓库中的当前状态、handoff、plans、规则文档和历史证据，使当前执行面可信、规则层级唯一、历史材料可检索但不污染默认上下文。

## Problem

当前仓库存在 tasks/current.md 混入其他机器和旧 worktree 状态、codex-goal.md 使用不可移植绝对路径、resume 落后于 current、latest checks 基本为空、plans 根目录堆积大量已完成或被替代计划、PRD 目录混入研究报告、Sprint 命名不统一、AGENTS/CLAUDE 与 SKILL/reference rules 可能重复承载规则、handoff 目录混入长期证据等问题。这些问题使新会话难以判断真实当前任务，增加 Codex 读取成本，并产生多重事实源。

## Users

- 维护 repo-harness 的开发者
- 通过 ChatGPT 规划并由本地 Codex 执行的用户
- 需要从 handoff 恢复工作的后续会话

## Goals

- 让 tasks/current.md、handoff/current.md、resume.md 和 codex-goal.md 对当前仓库与机器保持一致
- 清理不可移植绝对路径和失效 worktree 指令
- 把 plans/ 收敛为明确的 active/ready 与 archive 边界
- 建立 PRD、Sprint、Contract、Review、Notes、Evidence 的清晰职责和索引
- 确定 AGENTS、CLAUDE、SKILL 与 reference-configs 的单一规则层级
- 将长期 MCP 证据移出 handoff 默认入口
- 让 workflow check 和状态摘要返回可信结果

## Non-goals

- 不修改 repo-harness 运行时代码
- 不删除仍有追溯价值的历史计划、合同、review 或 notes
- 不把所有规则合并成一个超长文件
- 不改变已发布产品行为或 CLI 契约
- 不以目录清理为由丢失历史证据

## Acceptance Criteria

- [ ] tasks/current.md 不再引用无法在当前仓库验证的外部用户目录或旧 worktree
- [ ] codex-goal.md 仅使用仓库相对路径或明确配置化引用
- [ ] resume.md 与 current.md 时间顺序正确
- [ ] latest checks 明确表达 not_run 或真实检查结果
- [ ] plans 根目录仅保留仍有效的计划，完成/取消/被替代项进入 archive
- [ ] PRD 目录只包含正式 PRD，研究报告移动到 docs/researches 或 docs/reports
- [ ] Sprint 文件名统一为 YYYYMMDD-slug.sprint.md
- [ ] AGENTS/CLAUDE 明确 canonical 与 generated mirror 关系
- [ ] SKILL 不重复承载完整工程治理规则
- [ ] handoff 目录仅保留当前启动所需文件
- [ ] 严格 workflow check 通过或只剩外部环境型警告

## Workflow Contract

- PRD is the source of product intent.
- Sprint must be generated as ordered checklist task cards.
- Codex execution must happen through a host-native `/goal` prompt or local Codex session, not through remote MCP execution.

## Handoff Notes

本任务针对 /Users/greyson/DevProjects/repo-harness。当前 keepalive 已恢复，仓库 profile=planner。先修控制面，再处理历史归档；不要一次性删除大量文件。
