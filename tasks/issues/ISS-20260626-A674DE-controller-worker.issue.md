---
id: "ISS-20260626-A674DE"
kind: "bug"
status: "in_progress"
updated_at: "2026-06-29T13:26:56.663Z"
source: "repo-harness-controller-v8"
---

# Controller worker 生命周期与性能硬保护

系统性消除重复 worker、空闲 CPU 空转、孤儿进程、租约失效、并发失控和临时状态泄漏。所有修复直接在当前 main 工作区完成，每个独立修复单独提交，不创建分支或 worktree。

## Goals

- 同一 jobId 只能存在一个活跃 worker
- 空闲 worker 使用等待或有上限的指数退避
- Controller 退出、任务取消和超时后完整回收子进程树
- worker 使用心跳和 lease，在 Controller 不可达或 lease 过期后退出
- 增加全局与单仓库 worker 上限
- 增加同任务互斥
- 自动回收临时目录和遗留 PID
- 持续验证 502、CPU 空转和进程泄漏

## Non-goals

- 不引入新的 worktree 或长期分支
- 不扩大 Agent 并行度

## Acceptance Criteria

- [ ] 空闲状态无持续高 CPU worker
- [ ] 重复调度同一 jobId 不会创建第二个活跃 worker
- [ ] 取消、超时和 Controller 退出后无孤儿子进程
- [ ] lease 过期 worker 自动退出
- [ ] 并发上限和互斥锁有回归测试
- [ ] 启动和周期清理可回收遗留 PID 与临时目录
- [ ] 每个独立修复有单独提交和测试证据

## GitHub

- Not published.

## Tasks

### T1 — 审计并修复同 jobId 单 worker 与任务互斥

- Status: `review`
- Objective: 确认 claim/dispatch/spawn 路径，增加原子互斥和重复启动保护。
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/controller/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T2 — 修复空闲轮询与 lease 心跳生命周期

- Status: `review`
- Objective: 空闲轮询改为等待或有上限退避，并确保 worker 在 lease 或 Controller 心跳失效后退出。
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/controller/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — 完善取消、超时和退出的进程树回收

- Status: `review`
- Objective: 统一关闭路径，确保完整子进程树被终止并等待回收。
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/controller/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T4 — 增加 worker 并发硬上限

- Status: `verified`
- Objective: 增加全局和单仓库 worker 上限并在调度器中 fail-closed。
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/controller/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T5 — 增加临时目录和遗留 PID 自动清理

- Status: `verified`
- Objective: 启动时和周期性回收不再存活的 PID 文件、孤立工作目录和过期临时状态。
- Depends on: none
- Allowed paths: `src/runtime/**`, `src/cli/controller/**`, `scripts/**`, `tests/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T6 — 复验 502 与整体性能

- Status: `blocked`
- Objective: 在全部生命周期修复后复验响应上限、CPU、进程数、临时目录和完整门禁。
- Depends on: none
- Allowed paths: `src/**`, `tests/**`, `scripts/**`, `tasks/reports/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T7 — 修复测试与 legacy worker 的孤儿进程泄漏

- Status: `blocked`
- Objective: 确保 local bridge、repository MCP restore 和 controller service 测试结束时先终止并等待临时 daemon、launcher、job-worker 及 agent 子进程树，再删除临时目录；同时让 legacy worker 在 ownership 元数据丢失、父进程断开或配置目录被删除时 fail-closed 退出且不空转。
- Depends on: none
- Allowed paths: `src/cli/agent-jobs/job-worker.ts`, `src/cli/agent-jobs/job-manager.ts`, `src/cli/agent-jobs/worker-lifecycle.ts`, `tests/cli/local-bridge.test.ts`, `tests/cli/repository-mcp-command.test.ts`, `tests/cli/controller-service.test.ts`, `tests/runtime/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T8 — 增加 runtime health 巡检命令与每小时调度

- Status: `planned`
- Objective: 提供有界、只读、可机器解析的 runtime health 检查，汇总 Controller/Gateway/Scheduler/Local Bridge、队列/lease、repo-harness 进程身份、孤儿临时 worker、CPU 异常、临时目录与 worktree 增长，并可由 Controller Schedule 每小时执行。
- Depends on: `T7`
- Allowed paths: `src/cli/**`, `src/runtime/**`, `scripts/**`, `tests/**`, `package.json`, `.repo-harness/checks.json`, `docs/**`
- Checks: `package:check:type`
- Execution hint: agent / codex

### T9 — 修复 MCP 会话频繁终止与自动恢复

- Status: `ready`
- Objective: 定位并消除 ChatGPT connector 经常返回 Session terminated 的根因，确保 Gateway/keepalive/Controller 重启、长任务、测试子进程异常和认证刷新期间 MCP 会话可恢复，且持久 Job 可在新会话中无损继续读取。
- Depends on: none
- Allowed paths: `src/cli/mcp/**`, `src/runtime/gateway/**`, `src/cli/controller/**`, `scripts/controller-runtime.sh`, `tests/cli/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T10 — 通过 GitHub PR 修复 MCP 会话终止

- Status: `ready`
- Objective: 在 GitHub 远程分支修复 keepalive 对仍存活 MCP Gateway 的激进重启：短暂 /health 失败仅标记 degraded 并保留现有 session；Gateway 进程退出时立即重启；仅持续失联超过约 5 分钟才重启仍存活 Gateway。补充定向回归测试并创建 PR 到 main。
- Depends on: none
- Allowed paths: `src/cli/mcp/keepalive.ts`, `tests/cli/mcp-keepalive.test.ts`
- Checks: `package:check:type`
- Execution hint: agent / github-copilot

## Related Artifacts

- None.
