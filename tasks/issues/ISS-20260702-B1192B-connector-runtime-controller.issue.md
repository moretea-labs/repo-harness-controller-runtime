---
id: "ISS-20260702-B1192B"
kind: "feature"
status: "planned"
updated_at: "2026-07-02T03:56:51.306Z"
source: "repo-harness-controller-v8"
---

# 重构 Connector 稳定性、Runtime 存储与 Controller 核心工作流

按分阶段迁移方式收缩 repo-harness 控制面：先稳定 Gateway/Daemon/Tunnel 边界和断线恢复，再降低 Execution Job 高频文件写放大，随后统一核心工作接口与默认 MCP 工具面。兼容层保留到新路径完成验证后再删除。

## Goals

- Gateway、Daemon、Tunnel 和 UI 具备独立生命周期与故障边界
- MCP 断线或 Gateway 重启后可通过持久 work/request 标识恢复同一任务
- Execution Job 心跳和状态更新不再反复重写大型 active/recent JSON 索引
- 默认 Connector 只暴露稳定的核心意图级工具，legacy 工具通过显式 profile 提供
- Controller 主视图围绕 Attention、Running、Review、Completed 组织
- 所有阶段具备定向测试、回归测试、源码审查和可回滚提交

## Non-goals

- 本轮不一次性删除所有 legacy 文件格式和工具
- 不在缺少兼容迁移验证时强制转换已有用户运行数据
- 不把外部云 Agent 作为完成重构的必要条件

## Acceptance Criteria

- [ ] 瞬时健康检查失败不会杀死仍存活 Gateway，真实进程退出可立即恢复
- [ ] 重新建立 MCP Session 后能按 requestId/workId 查询并继续观察既有 durable execution
- [ ] 高频 heartbeat 不更新全量 active/recent 文件索引，调度与最近任务查询仍正确
- [ ] 默认核心工具面显著缩小且兼容 profile 可继续使用既有工具
- [ ] Controller Context 和主状态读取有界且不会因读取动作创建重型后台扫描
- [ ] 全部新增测试、类型检查、MCP compatibility 和 Controller v8 门禁通过，或明确记录非本次阻塞
- [ ] 完成代码 review、提交、合并并生成不含运行时垃圾的完整源码压缩包

## GitHub

- Not published.

## Tasks

### T1 — 隔离 Gateway、Daemon、Tunnel 生命周期并完善 Session 恢复

- Status: `ready`
- Objective: 修复 keepalive 激进重启和组件耦合；增加稳定 work/request 恢复入口及故障注入测试。
- Depends on: none
- Allowed paths: `src/cli/mcp/**`, `src/cli/controller/**`, `src/runtime/gateway/**`, `scripts/controller-runtime.sh`, `tests/cli/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`
- Execution hint: selected at runtime

### T2 — 消除 Execution Job 高频索引写放大

- Status: `planned`
- Objective: 将 heartbeat/lease 等高频更新从 active/recent 全量 JSON 重写中解耦，引入增量或数据库索引，同时保持兼容读取和恢复。
- Depends on: `T1`
- Allowed paths: `src/runtime/execution/**`, `src/runtime/resources/**`, `src/runtime/control-plane/**`, `src/runtime/projections/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`, `package:check:runtime-architecture`
- Execution hint: selected at runtime

### T3 — 建立核心 Work 接口并收缩默认 MCP 工具面

- Status: `planned`
- Objective: 在兼容现有 Job/Run 的前提下提供统一 work_submit/work_get/work_cancel/work_diff/work_verify/work_integrate 等核心入口，并支持 core/workflow/admin/legacy profile。
- Depends on: `T1`, `T2`
- Allowed paths: `src/runtime/gateway/**`, `src/cli/mcp/**`, `src/cli/controller/**`, `tests/runtime/**`, `tests/cli/**`, `docs/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T4 — 重构 Controller 主状态与 UI 信息架构

- Status: `planned`
- Objective: 将主视图改为 Needs Attention、Running Now、Ready for Review、Recently Completed，并把 Scheduler/Lease/Process 等移入诊断页。
- Depends on: `T3`
- Allowed paths: `src/cli/local-bridge/**`, `src/runtime/projections/**`, `tests/cli/**`, `tests/runtime/**`, `docs/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: selected at runtime

### T5 — 全量审查、回归、合并与源码打包

- Status: `planned`
- Objective: 对全部重构做独立 review、故障注入、完整门禁、提交整理、合并清理和源码归档。
- Depends on: `T1`, `T2`, `T3`, `T4`
- Allowed paths: `src/**`, `tests/**`, `scripts/**`, `docs/**`, `package.json`, `tasks/reports/**`
- Checks: `package:check:type`, `package:check:mcp-compatibility`, `package:check:runtime-architecture`, `package:check:controller-v8`, `package:test`
- Execution hint: selected at runtime

## Related Artifacts

- None.
