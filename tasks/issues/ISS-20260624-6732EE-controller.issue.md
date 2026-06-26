---
id: "ISS-20260624-6732EE"
kind: "bug"
status: "in_progress"
updated_at: "2026-06-26T08:48:01.979Z"
source: "repo-harness-controller-v8"
---

# 修复 Controller 重连崩溃与执行链路性能瓶颈

修复 ChatGPT Connector/Controller 频繁重连或挂掉、Local Bridge run-check 僵尸状态与超时失效、历史 Job 全量扫描和重型检查重复并发，并减少状态接口负载和日常任务编排开销。实施时优先使用 bounded Direct Edit，不启动 Agent。

## Goals

- Controller/Connector 在大状态量和历史任务存在时保持稳定，不因单次状态查询产生 502 或频繁重连
- run-check 超时、进程中断和 Controller 重启后能可靠收口，不遗留永久 running Job
- 相同仓库的相同重型检查可去重，避免重复并发竞争
- Local Bridge 状态查询只读取必要的最近/活跃任务，避免全量历史读写
- 为常用状态接口提供更紧凑的默认响应并保留按需详细读取能力
- 补充针对重启恢复、超时、僵尸任务、查询上限和检查去重的回归测试

## Non-goals

- 本轮不重写整个 MCP transport 或替换 Connector 协议
- 本轮不启动 Codex、Claude 或 Copilot Agent
- 本轮不处理当前开源治理 Issue T8 的破坏性 Git 清理

## Acceptance Criteria

- [ ] Controller 重启后过期或无存活执行依据的 running run-check Job 自动转为 failed/timed_out/orphaned 终态
- [ ] run-check 达到配置超时后不会长期保持 running，并记录明确错误与 finishedAt
- [ ] Local Bridge 状态查询不会为了返回最近 25 条而刷新全部历史 Job
- [ ] 相同 checkId 和相同代码 Revision 已有运行中任务时不会再次启动重复检查
- [ ] Connector 常用状态响应大小显著受控，重复心跳或大历史列表不会默认返回
- [ ] 相关专项测试和类型检查通过

## GitHub

- Not published.

## Tasks

### T1 — 修复 Controller 重连与启动恢复

- Status: `done`
- Objective: 检查 MCP keepalive、runtime state 和 Local Controller 生命周期；修复异常退出、重启后运行状态失真及容易导致 Connector 502/重连的恢复路径。
- Depends on: none
- Allowed paths: `src/cli/mcp/**`, `src/cli/local-bridge/**`, `tests/cli/mcp-*.test.ts`, `tests/cli/local-bridge*.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T2 — 修复 run-check 超时、僵尸任务与重复执行

- Status: `done`
- Objective: 为 Local Bridge run-check 增加可恢复的 deadline/状态收口、孤儿检测、同 Revision 同 Check 去重和仓库级重型检查并发保护。
- Depends on: `T1`
- Allowed paths: `src/cli/local-bridge/**`, `src/cli/controller/check-runner.ts`, `src/cli/controller/**`, `tests/cli/local-bridge*.test.ts`, `tests/cli/controller*.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — 优化状态查询与 Connector 响应负载

- Status: `superseded`
- Objective: 让 Local Bridge Job 列表先限量再读取/刷新，活跃与历史状态分离，并压缩 project_snapshot、local_bridge_status 和事件读取的默认数据量。
- Depends on: `T2`
- Allowed paths: `src/cli/local-bridge/**`, `src/cli/mcp/tools.ts`, `tests/cli/mcp-controller.test.ts`, `tests/cli/local-bridge*.test.ts`, `docs/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime
- Superseded by: `T14`, `T15`

### T4 — 完善 Direct Edit First 与分层验证策略

- Status: `planned`
- Objective: 收紧工具路由和验证提示，使小中型改动默认 search + Direct Edit + targeted checks，完整 release gate 仅在最终发布阶段执行，并补充文档和回归断言。
- Depends on: `T14`, `T15`
- Allowed paths: `src/cli/mcp/**`, `src/cli/controller/**`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T5 — 恢复公开包元数据并清理空编辑会话

- Status: `done`
- Objective: 移除误加的 package.json private 标记，保持公开 npm 包契约；关闭或回滚没有任何变更的遗留 Direct Edit 会话，恢复干净且可验证的工作区。
- Depends on: none
- Allowed paths: `package.json`, `tests/bootstrap-files.test.ts`, `.ai/harness/edit-sessions/**`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T6 — 稳定仓库身份与远程映射

- Status: `superseded`
- Objective: 修复 repository refresh 在同一路径 remote 变化时生成重复 repoId 的问题；保持既有 repoId、Issue、Run 和 Edit Session 绑定稳定，并让 Registry remote、实际 Git origin 与 GitHub 插件映射能够明确校验和安全更新。
- Depends on: none
- Allowed paths: `src/cli/repository-registry/**`, `src/cli/controller/**`, `src/cli/mcp/**`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime
- Superseded by: `T16`

### T7 — 执行最终回归并准备 MCP 重启

- Status: `planned`
- Objective: 在全部修复集成后执行分层回归，确认 Controller、MCP、Local Bridge、仓库身份和公开包契约均通过；输出可重启状态，重启后再次进行健康检查。
- Depends on: `T4`, `T16`
- Allowed paths: `tests/**`, `scripts/**`, `docs/**`, `tasks/reports/**`
- Checks: `package:check:type`, `package:check:controller-v8`, `package:check:release-surface`
- Execution hint: selected at runtime

### T8 — 原子化 Agent 运行结果持久化

- Status: `superseded`
- Objective: 修复 Agent worker 写入 result/meta JSON 时被 Controller 并发读取导致 Unexpected EOF 的竞态；统一使用原子替换或可恢复读取，并补充高频轮询回归测试。
- Depends on: `T1`
- Allowed paths: `src/cli/agent-jobs/**`, `tests/cli/local-bridge.test.ts`, `tests/cli/mcp-controller.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime
- Superseded by: `T10`, `T11`

### T9 — 修复并发调度规则

- Status: `superseded`
- Objective: 修复重型检查并发和本地 Run 工作区选择的跨进程竞态。
- Depends on: `T2`
- Allowed paths: `src/cli/controller/check-runner.ts`, `src/cli/agent-jobs/**`, `tests/cli/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime
- Superseded by: `T12`, `T13`

### T10 — 收敛 Agent 状态文件原子持久化

- Status: `planned`
- Objective: 统一 Agent meta/result JSON 原子写入和可恢复读取，避免高频轮询读取半写入文件；保留现有状态语义，不改变正常 Run 生命周期。
- Depends on: `T1`, `T15`
- Allowed paths: `src/cli/agent-jobs/job-manager.ts`, `src/cli/agent-jobs/job-worker.ts`, `tests/cli/local-bridge.test.ts`, `tests/cli/mcp-controller.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T11 — 修复自动集成 Run 终态一致性

- Status: `ready`
- Objective: 确保 worktree 自动集成 Run 只有在集成完成并清理，或记录明确 autoIntegrationError 后才进入成功终态；worker 在 result 写入后异常退出不得被恢复为假成功。
- Depends on: `T1`
- Allowed paths: `src/cli/agent-jobs/integration.ts`, `src/cli/agent-jobs/job-manager.ts`, `src/cli/agent-jobs/job-worker.ts`, `tests/cli/local-bridge.test.ts`, `tests/cli/mcp-controller.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T12 — 收敛检查进程树与证据 Revision

- Status: `ready`
- Objective: 确保检查任务只有在完整子进程树退出后才进入终态；检查执行期间仓库 Revision 变化时不得生成可复用成功证据，并为排队/持锁阶段提供可观测状态。
- Depends on: `T2`
- Allowed paths: `src/cli/controller/check-runner.ts`, `src/cli/local-bridge/job-store.ts`, `tests/cli/local-bridge.test.ts`, `tests/cli/mcp-controller.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T13 — 修复共享检查订阅与取消语义

- Status: `ready`
- Objective: 将同 Revision 同 Check 的执行去重建模为共享执行加独立订阅者；单个 Job 取消、超时或变 stale 不得终止其他仍活跃订阅者使用的共享检查。
- Depends on: `T2`
- Allowed paths: `src/cli/controller/check-runner.ts`, `src/cli/local-bridge/job-store.ts`, `tests/cli/local-bridge.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T14 — 压缩 MCP 默认响应并保持兼容

- Status: `review`
- Objective: 移除 launch_task、verify_task 等工具返回中顶层与嵌套完整对象的重复副本；默认返回紧凑摘要，同时保留专用详情工具和必要兼容字段。
- Depends on: `T2`
- Allowed paths: `src/cli/mcp/tools.ts`, `tests/cli/mcp-controller.test.ts`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T15 — 建立活跃检查索引并限制历史扫描

- Status: `blocked`
- Objective: 将 run-check 去重与活跃状态读取从最近历史窗口中分离，优先读取非终态索引；历史列表只按请求上限读取，不因检查去重扫描大量旧 Job。
- Depends on: `T2`
- Allowed paths: `src/cli/local-bridge/job-store.ts`, `src/cli/local-bridge/types.ts`, `tests/cli/local-bridge.test.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T16 — 补充仓库远程映射一致性诊断

- Status: `ready`
- Objective: 保持 repoId 与 canonicalRoot 稳定；在 Git origin、Registry remote 和 GitHub 插件目标不一致时返回明确 warning，不静默重绑既有 Issue、Run 或 Edit Session。
- Depends on: none
- Allowed paths: `src/cli/repositories/registry.ts`, `tests/cli/repository-registry-v81.test.ts`, `src/cli/mcp/tools.ts`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T17 — 限制 Durable Job 错误与列表响应体

- Status: `planned`
- Objective: 避免 MCP/Repository 工具失败时把完整 repository、runtimeStorage 和大日志嵌入 ExecutionJob.error；为 list_jobs/get_job 默认响应建立有界摘要，详情通过 Evidence/Artifact 按需读取，从而降低 Connector 502 与持久化历史膨胀。
- Depends on: `T14`
- Allowed paths: `src/runtime/execution/**`, `src/runtime/gateway/**`, `tests/runtime/**`, `tests/cli/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T18 — 收敛 Git 基线与工作区拓扑

- Status: `planned`
- Objective: 以 origin/main 为唯一集成基线，审计并安全整理当前 feature、linked worktree、本地/远端临时分支和 PR；保留所有未提交内容与未合并唯一提交，先生成可恢复清单，再执行已终态且无唯一成果的清理。
- Depends on: `T21`
- Allowed paths: `tasks/reports/**`, `docs/**`, `.github/**`
- Checks: not defined
- Execution hint: agent / codex

### T19 — 停止并根治孤儿 Job Worker CPU 泄露

- Status: `changes_requested`
- Objective: 先识别并安全终止无活跃 Job/Lease 所有权的 detached job-worker.ts 进程；随后修复 worker 启动与生命周期协议，增加父进程、Controller epoch、Job 状态和 Lease/fencing 存活校验，确保遗留临时仓库无法持续占用 CPU。
- Depends on: none
- Allowed paths: `src/cli/agent-jobs/**`, `src/cli/local-bridge/**`, `src/runtime/execution/**`, `src/runtime/resources/**`, `tests/cli/**`, `tests/runtime/**`, `scripts/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T20 — 统一 Controller 一键启动与生命周期脚本

- Status: `planned`
- Objective: 整理项目启动入口，提供一键启动、停止、状态、日志和安全重启能力；启动前做环境、端口、PID、版本、仓库根目录和孤儿进程检查，避免重复实例和 detached worker 遗留。
- Depends on: `T19`
- Allowed paths: `scripts/**`, `package.json`, `src/cli/**`, `tests/**`, `README.md`, `README.zh-CN.md`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T21 — 自动收敛已完成任务的分支与 Worktree

- Status: `planned`
- Objective: 将 Task Run 完成后的提交、验证、集成和清理建模为一个原子化收尾流程：成功 Run 应尽快提交代码、集成到目标基线、删除已清洁且无唯一提交的临时 branch/worktree，并在失败时保留可恢复证据和明确阻断原因。
- Depends on: `T19`, `T20`
- Allowed paths: `src/cli/agent-jobs/**`, `src/runtime/execution/**`, `src/runtime/integration/**`, `src/cli/repositories/**`, `tests/**`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T22 — 避免工具读取响应触发平台安全误拦截

- Status: `planned`
- Objective: 重构 get_task_run、get_task_progress_detail、get_task_run_log、Job/Run 列表等读取接口的默认返回：默认仅返回结构化摘要和有界尾部，去除完整命令、Prompt、绝对路径、进程列表及嵌套 repository/runtimeStorage；详细内容通过显式分页、artifact 或 opt-in 字段读取。检测到上游安全拦截或响应拒绝时，自动降级到 compact summary，而不是重复返回同一高风险载荷。
- Depends on: `T17`
- Allowed paths: `src/cli/mcp/**`, `src/runtime/gateway/**`, `src/cli/agent-jobs/**`, `src/runtime/execution/**`, `tests/cli/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- `src/cli/local-bridge/job-store.ts`
- `src/cli/mcp/tools.ts`
- `src/cli/mcp/keepalive.ts`
- `src/cli/controller/check-runner.ts`
- `tests/cli/local-bridge.test.ts`
- `tests/cli/mcp-controller.test.ts`
