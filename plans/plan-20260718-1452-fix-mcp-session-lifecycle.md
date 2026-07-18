# Plan: 根治 MCP 会话生命周期导致的 502

> **Status**: Executing
> **Created**: 20260718-1452
> **Slug**: fix-mcp-session-lifecycle
> **Planning Source**: codex-plan
> **Orchestration Kind**: host-plan
> **Source Ref**: (none)
> **Spec**: `docs/spec.md`
> **Research**: See `docs/researches/`
> **Task Contract**: `tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md`
> **Task Review**: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`
> **Implementation Notes**: `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`

## Agentic Routing
- Selected route: architecture-runtime
- Routing reason: Captured from codex-plan planning output.
- Source ref: (none)
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260718-1452-fix-mcp-session-lifecycle.md`
- Sprint contract: `tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md`
- Sprint review: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`
- Implementation notes: `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`
- Deferred-goal ledger: `tasks/todos.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260718-1452-fix-mcp-session-lifecycle.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260718-1452-fix-mcp-session-lifecycle.md`.

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
- Contract file: `tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md`
- Review file: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`
- Implementation notes file: `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260718-1452-fix-mcp-session-lifecycle.md` task breakdown, `tasks/todos.md` deferred-goal ledger, `tasks/contracts/20260718-1452-fix-mcp-session-lifecycle.contract.md`, `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md`, and `tasks/notes/20260718-1452-fix-mcp-session-lifecycle.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260718-1452-fix-mcp-session-lifecycle.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260718-1452-fix-mcp-session-lifecycle.md`; after execution revert branch `codex/fix-mcp-session-lifecycle` or the generated task artifacts

## Captured Planning Output

# 502 根因整改实施合同

## Goal

从会话生命周期、健康判定和稳定入口隔离三个层面消除“运行一段时间后 502/503”的系统性故障。当前已确认的直接根因是 Streamable HTTP 会话达到 64 个上限后，仍有 SSE GET 的会话不会被回收；`/health` 与 `/ready` 同时继续报告健康，使 Supervisor 无法发现或修复容量耗尽。

## Confirmed Evidence

- 线上 MCP 进程显示 `active=64`、`maximum=64`、`activeStreams=64`、`activePosts=0`，新 initialize 返回 `503 session_capacity`。
- 三个传输入口各自维护会话 Map，却在健康指标中把上限表达为单一 64，容量语义不一致。
- 服务未注册 SDK 已支持的 DELETE 路由，正常客户端无法显式关闭会话。
- 当前清理逻辑只回收没有活动 GET 的会话，SSE 长连接因此可永久占位。
- `/ready` 不检查会话容量；Supervisor 仅依据 `/health.status=ok` 判断后端健康。
- 历史日志还显示发布期间旧 Supervisor/child 残留和端口占用，是第二类 502 风险。

## Architecture Decisions

1. 三个 MCP 路径共享一个全局会话注册表和一个真实全局容量上限，路由只作为认证/协议入口，不再形成独立容量池。
2. SSE 是传输通道，不代表正在执行工作。只有活动 POST 受强保护；stream-only 会话必须具有确定的租约和最大寿命。
3. 会话记录至少包含创建时间、最近活动时间、流打开时间、入口、主体标识、活动 POST/GET 和关闭原因。
4. 支持 DELETE 正常关闭；相同主体重连时优先替换旧的 idle/stream-only 会话；容量压力下回收最老且无活动 POST 的会话，然后再接受新 initialize。
5. liveness 与 readiness 分离：`/health` 只证明事件循环存活，`/ready` 必须反映是否还能接受新会话，并暴露利用率、最老流年龄、回收/拒绝计数。
6. Supervisor 使用 readiness/capacity 信号，先做会话层恢复，再把无法恢复的饱和视为不健康；稳定入口的数据面生命周期应与 Supervisor 控制/救援职责隔离，避免长连接占用生命周期所有者。
7. 架构状态在长时压力验证通过前标记为 Partial/Drift，不把已有的局部修复描述成完整实现。

## Scope

- `src/cli/mcp/transports/http.ts` 及必要的新会话注册表模块。
- `src/runtime/supervisor/ingress-router.ts`、`src/runtime/supervisor/supervisor-runtime.ts` 及相关稳定入口启动代码。
- MCP HTTP、Supervisor、目标架构的测试与压力/重连回归测试。
- `docs/architecture/`、`docs/operations/controller-performance-and-502.md`、能力边界注册表和必要的任务同步文件。

## Non-goals

- 本分支不自动切换当前线上进程，不改 `_ops/*`，不触碰真实凭证或 Cloudflare 配置。
- 不把本次根因修复扩大为所有 Gateway 工具执行模型的全面重写；手工隔离列表的后续治理应记录为独立架构债务，除非实现稳定入口隔离必须调整。

## Test-first Evidence Strategy

- 先扩展现有 MCP HTTP 测试并观察失败：DELETE 关闭、跨入口全局容量、相同主体替换、stream-only 容量回收、活动 POST 保护、饱和 readiness。
- 增加真实 HTTP 重连风暴测试：连续至少 500 次 initialize/open/drop 后仍能接受新 initialize，且会话数回落。
- 增加 Supervisor 集成测试：容量不可恢复时不能继续报告 ready；稳定入口在数据面饱和时仍能响应控制/救援探测。
- 实现后运行聚焦测试、完整 `bun test` 和仓库所有 required checks。

## Acceptance Criteria

- [ ] DELETE 在 `/mcp`、`/mcp-grok`、`/mcp-bearer` 三个入口都能关闭并移除会话。
- [ ] 全局会话上限跨三个入口准确生效，指标中的 active/maximum/utilization 一致。
- [ ] 满载时可确定回收无活动 POST 的最老 stream-only 会话，新 initialize 不因陈旧 SSE 单调失败。
- [ ] 活动 POST 从不被容量回收；会话租约/最大寿命不会中断实际执行中的请求。
- [ ] `/ready` 在无法安全接受新会话时返回 503，`/health` 仍只表达 liveness。
- [ ] Supervisor 能识别容量耗尽并执行有界恢复，稳定入口控制面不被长连接数据面拖死。
- [ ] 500 次重连风暴回归测试通过；新增失败场景与恢复场景均有自动化覆盖。
- [ ] 架构、运维、能力边界和任务状态与实现一致。
- [ ] 所有仓库 required checks 通过。

## Task Breakdown

- [ ] 建立会话生命周期与容量语义的失败测试基线
- [ ] 实现统一会话注册表、DELETE、租约和安全容量回收
- [ ] 修正 readiness 指标并让 Supervisor 消费容量健康信号
- [ ] 隔离稳定入口数据面与控制/救援生命周期职责
- [ ] 增加重连风暴和故障恢复集成覆盖
- [ ] 同步架构、运维、能力边界与任务合同
- [ ] 运行完整验证、代码审查并修复发现的问题

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] 建立会话生命周期与容量语义的失败测试基线
- [ ] 实现统一会话注册表、DELETE、租约和安全容量回收
- [ ] 修正 readiness 指标并让 Supervisor 消费容量健康信号
- [ ] 隔离稳定入口数据面与控制/救援生命周期职责
- [ ] 增加重连风暴和故障恢复集成覆盖
- [ ] 同步架构、运维、能力边界与任务合同
- [ ] 运行完整验证、代码审查并修复发现的问题
