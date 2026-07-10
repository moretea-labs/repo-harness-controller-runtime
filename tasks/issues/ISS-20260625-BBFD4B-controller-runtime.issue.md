---
id: "ISS-20260625-BBFD4B"
kind: "governance"
status: "cancelled"
updated_at: "2026-07-10T13:41:30.226Z"
archived_at: "2026-07-10T13:41:30.226Z"
source: "repo-harness-controller-v8"
---

# 建立 Controller Runtime 当前架构事实源与文档治理

基于已确认的 Thin Gateway + Global Scheduler + Per-Repository Actor + Durable Job + Isolated Worker + Evidence Plane 目标架构，建立 repo-harness 唯一当前架构事实源，明确实体、职责、并发、冲突、Schedule、恢复、验证和发布规则；将 V5-V8 等代际设计降级为历史说明，并以自动检查防止后续文档漂移。

## Goals

- 建立 docs/architecture/current/ 作为 Controller Runtime 唯一当前架构事实源
- 明确控制面、调度面、执行面、状态面和证据面的职责边界与禁止事项
- 固化 Issue/Task/Job/Run/Edit Session/Verification/Schedule/Occurrence/Lease 等实体关系和生命周期
- 固化单仓库冲突策略、多仓库并发、公平调度、Worktree 与 Integration Queue 策略
- 定义循环任务的 bounded Occurrence、幂等、预算、退避、停止条件和需求候选治理
- 定义精确 Revision 验证、Release Freeze、发布门和人工授权边界
- 将旧代际架构文档统一标记为 Historical Design，并只保留到当前事实源的入口
- 新增文档一致性检查，阻止权威边界、必备文档或历史标识漂移

## Non-goals

- 本 Issue 不修改 MCP、Controller、Local Bridge 或 Agent Runtime 实现
- 本 Issue 不修复当前 502、T14/T15 或其他运行时缺陷
- 本 Issue 不提交、推送、发布或修改 Git 历史
- 本 Issue 不立即实现 Schedule Engine、Repo Actor 或 Worker 进程拆分
- 本 Issue 不覆盖 package.json 和 src/cli/local-bridge/types.ts 当前未提交改动

## Acceptance Criteria

- [ ] docs/architecture/current/ 中存在完整的当前架构文档集合并由 index 明确声明为唯一 Runtime Authority
- [ ] 当前架构文档覆盖系统边界、架构宪法、实体生命周期、任务分派、资源 Claim、单仓库冲突、多仓库并发、Schedule、故障恢复、验证和发布
- [ ] 旧 V5-V8 与旧 Controller/Local Bridge 文档具有清晰 Historical Design 标识且链接当前架构入口
- [ ] 文档明确 MCP 不执行长任务、先持久化后执行、请求幂等、Task 与 Run 分离、仓库 Actor 自治、锁与 Lease 分离、验证绑定 Revision 等不可违反规则
- [ ] 文档一致性检查能够检测缺失当前架构文件、缺失 Runtime Authority 声明和旧代际文档缺失历史标识
- [ ] package:check:architecture-sync、相关专项测试和 package:check:type 通过

## GitHub

- Not published.

## Tasks

### T1 — 定义当前架构权威边界与治理规则

- Status: `done`
- Objective: 重写架构入口并建立 current 目录的 README/治理契约，明确哪些文档是 Runtime Authority、哪些是历史资料，以及架构变更的 ADR/同步规则。
- Depends on: none
- Allowed paths: `docs/architecture/index.md`, `docs/architecture/current/**`
- Checks: `package:check:architecture-sync`
- Execution hint: selected at runtime

### T2 — 落地主架构、架构宪法与实体生命周期

- Status: `done`
- Objective: 编写系统总览、架构不变量、实体模型、Job/Run/Edit/Verification 生命周期，固化控制面和执行面分离规则。
- Depends on: `T1`
- Allowed paths: `docs/architecture/current/**`
- Checks: `package:check:architecture-sync`
- Execution hint: selected at runtime

### T3 — 落地调度、冲突、多仓库与 Schedule 架构

- Status: `done`
- Objective: 编写工作模式选择、Agent 角色、资源 Claim/Lease、Workspace/Worktree、Integration Queue、多仓库公平调度、Portfolio Saga 和循环任务 bounded Occurrence 设计。
- Depends on: `T2`
- Allowed paths: `docs/architecture/current/**`
- Checks: `package:check:architecture-sync`
- Execution hint: selected at runtime

### T4 — 落地故障恢复、验证与发布门

- Status: `done`
- Objective: 编写 Gateway/Controller/Worker 故障边界、Lease/Fencing、重启恢复、状态索引、分层验证、Release Freeze 和人工授权边界。
- Depends on: `T3`
- Allowed paths: `docs/architecture/current/**`
- Checks: `package:check:architecture-sync`
- Execution hint: selected at runtime

### T5 — 降级旧代际文档并统一入口

- Status: `done`
- Objective: 为旧 Controller、Local Bridge、V7、V8 及相关代际文档增加统一 Historical Design 标识和当前架构链接，删除相互冲突的权威声明。
- Depends on: `T4`
- Allowed paths: `docs/repo-harness-chatgpt-controller.md`, `docs/repo-harness-local-execution-bridge.md`, `docs/repo-harness-execution-closure-v5.md`, `docs/repo-harness-direct-change-v6.md`, `docs/repo-harness-execution-first-v7.md`, `docs/repo-harness-chatgpt-bridge-v8.md`, `docs/repo-harness-v8-verification.md`, `docs/architecture/index.md`
- Checks: `package:check:architecture-sync`
- Execution hint: selected at runtime

### T6 — 增加架构文档一致性门禁

- Status: `running`
- Objective: 扩展 architecture sync 检查与测试，校验 current 文档集合、Runtime Authority 声明、历史文档标识和关键架构不变量关键词。
- Depends on: `T5`
- Allowed paths: `scripts/check-architecture-sync.sh`, `tests/architecture-sync.test.ts`, `docs/architecture/current/**`, `docs/architecture/index.md`
- Checks: `package:check:architecture-sync`, `package:check:type`
- Execution hint: selected at runtime

### T7 — 执行文档治理终审与基线冻结

- Status: `planned`
- Objective: 审查当前架构文档内部一致性、链接、术语和与现有实现的事实区分，生成后续实现需求的收敛清单。
- Depends on: `T6`
- Allowed paths: `docs/architecture/current/**`, `docs/architecture/index.md`, `tasks/reports/**`
- Checks: `package:check:architecture-sync`, `package:check:type`
- Execution hint: selected at runtime

### T8 — 合并并删除旧版本架构文档

- Status: `blocked`
- Objective: 将 V4-V8、旧 Controller、Local Bridge 的设计与验证文档浓缩为一份架构演进历史，删除旧版本文档和文件清单，并更新 README、发布文件列表、MCP 文档白名单及当前架构治理规则。
- Depends on: `T5`
- Allowed paths: `docs/architecture/history.md`, `docs/architecture/index.md`, `docs/architecture/current/README.md`, `docs/architecture/current/governance.md`, `docs/architecture/current/architecture-invariants.md`, `docs/architecture/current/migration-roadmap.md`, `docs/repo-harness-progress-ledger-v4.md`, `docs/repo-harness-v4-verification.md`, `docs/repo-harness-v4-file-manifest.sha256`, `docs/repo-harness-execution-closure-v5.md`, `docs/repo-harness-v5-verification.md`, `docs/repo-harness-v5-file-manifest.sha256`, `docs/repo-harness-direct-change-v6.md`, `docs/repo-harness-v6-verification.md`, `docs/repo-harness-v6-file-manifest.sha256`, `docs/repo-harness-execution-first-v7.md`, `docs/repo-harness-chatgpt-bridge-v8.md`, `docs/repo-harness-v8-verification.md`, `docs/repo-harness-v8-file-manifest.sha256`, `docs/repo-harness-chatgpt-controller.md`, `docs/repo-harness-local-execution-bridge.md`, `README.md`, `README.zh-CN.md`, `package.json`, `src/cli/mcp/tools.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- `docs/architecture/index.md`
- `docs/architecture/current/`
- `docs/repo-harness-chatgpt-controller.md`
- `docs/repo-harness-local-execution-bridge.md`
- `docs/repo-harness-chatgpt-bridge-v8.md`
- `docs/repo-harness-execution-first-v7.md`
- `scripts/check-architecture-sync.sh`
- `tests/architecture-sync.test.ts`
