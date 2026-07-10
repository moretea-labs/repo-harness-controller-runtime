---
id: "ISS-20260709-FB0D74"
kind: "feature"
status: "done"
updated_at: "2026-07-10T11:44:39.527Z"
archived_at: "2026-07-10T11:44:39.527Z"
source: "repo-harness-controller-v8"
---

# feat(controller): wire facade workloop handoff and recovery loop - ChatGPT control plane stage 2

推进 repo-harness ChatGPT-facing 控制面第二阶段架构优化，实现 Goal Workloop / Handoff / Self-Healing / Codex 小脑协同闭环。基于已建模的 FacadeResult / Capability Registry / Policy Gate / Handoff Inbox 等基础契约，完成可实际工作的闭环。

## Goals

- 实现 Facade Routing 增强以支持 direct_control / goal_workloop / handoff_only 模式选择
- 新增/完善 WorkContract Store 使用 controller runtime storage
- 实现最小可工作的 Goal Workloop Engine (start/continue/verify/finalize/stop)
- 增强 Handoff Inbox 支持 pending decision 表达和 rh_inbox 操作
- 实现 Codex/Claude 小脑 Delegation 初版，bounded context pack，输出到 evidence/handoff/patch
- 实现 Self-Healing Loop 初版 (diagnose/repair/verify/handoff)
- 收敛 Tool Exposure，只保留 rh_status/rh_inbox/rh_context/rh_work
- 深化 Check Normalization / Verification Pollution 处理
- 添加 targeted tests 并通过 typecheck

## Non-goals

- 不把 repo-harness 改造成完整 LLM agent
- 不扩大测试范围到无关文件
- Direct Control 保持为小任务快速通道
- Codex/Claude 仅作为小脑执行器，不替代 ChatGPT 主控
- 不返回 raw stdout/stderr/完整 state/secrets

## Acceptance Criteria

- [ ] 小任务选择 direct_control，不创建 WorkContract
- [ ] 长任务选择 goal_workloop 并创建 WorkContract
- [ ] 高风险/缺授权任务创建 handoff_only
- [ ] Handoff item 支持 list/get/ack/resolve
- [ ] suggested_next_actions 只引用真实 registered check/tool/evidence/handoff/work id
- [ ] invalid check id 不污染为 acceptance failure
- [ ] infrastructure failure 不等同 acceptance failure
- [ ] Codex unavailable 生成 handoff/recovery suggestion
- [ ] self-healing diagnose 默认 dry_run
- [ ] facade result 默认 bounded
- [ ] typecheck pass
- [ ] bun test targeted files pass
- [ ] clean worktree after merge

## GitHub

- Not published.

## Tasks

- No tasks planned yet.
## Related Artifacts

- `OPTIMIZATION_REPORT.md`
- `docs/repo-harness-chatgpt-controller.md`
- `docs/repo-harness-runtime-self-healing-loop.md`
