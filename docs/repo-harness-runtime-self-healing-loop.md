# repo-harness 自修复闭环设计

## 目标

repo-harness 的自修复不能依赖已经故障的普通执行链路。尤其当 `repository_command_execute`、Direct Edit、Local Job、runtime storage relocation 被 `.ai/harness/local-jobs` 阻塞时，系统必须仍然能够通过本地维护执行器完成受限恢复。

这套设计把自修复分成五层：

1. **Observe**：只读探测 daemon、scheduler、runtime storage、Local Jobs、plugins、recent errors。
2. **Local Maintenance**：不走 `repository_command_execute`，不创建 Local Job，直接由 controller runtime 内置白名单维护动作修复 repo-harness metadata。
3. **Restart Fallback**：本地维护无效时，重启 repo-harness controller/local bridge，而不是无限重试业务动作。
4. **Model Repair Producer**：确认是源码缺陷后，再让 ChatGPT / local Codex CLI / DeepSeek 生成补丁。
5. **Continuation**：恢复后回到原始 durable intent，重试或要求用户确认外部副作用。

## 新增 MCP 工具

### `runtime_maintenance_status`

只读工具，返回当前 runtime maintenance plan。它不会读取任意源码文件，不会执行 shell，也不会创建 Local Job。

典型输出包括：

- `readyForExecution`
- `runtimeStorage.warnings`
- stale active Local Jobs
- unreadable / missing `job.json` entries
- recommended maintenance actions
- restart fallback
- advanced model repair plan

### `runtime_maintenance_apply`

写入工具，但只允许执行白名单 action：

- `local_jobs_reconcile`
- `quarantine_unreadable_local_jobs`
- `runtime_storage_finalize_relocation`
- `rebuild_projection`
- `full_maintenance_pass`

执行要求：

```json
{
  "confirm_maintenance": true,
  "authorization": "<same as action_id>"
}
```

它只改 repo-harness runtime metadata：

- `.ai/harness/local-jobs`
- `.ai/harness/local-jobs-quarantine`
- `.ai/harness/controller`
- `_ops/controller-home/repositories/<repo-id>`

它不改源码，不 push，不删除用户项目文件。

### `self_healing_loop_plan`

返回完整闭环计划，说明当前应由谁处理：

- repo-harness maintenance executor
- restart fallback
- ChatGPT supervised repair
- local Codex CLI repair
- DeepSeek backup controller
- human operator

## 决策原则

### 状态问题由 repo-harness 自己修

例如：

- `RUNTIME_STORAGE_NOT_READY`
- `local-jobs legacy-active`
- unreadable Local Job records
- stale active Local Jobs
- stale projections

这些都不应该进入 model-generated source repair。先走 maintenance executor。

### 源码缺陷才进入模型修复

例如：

- TypeError / ReferenceError
- invariant assertion failure
- repeated same recovery bug after restart
- recovery action 本身抛异常

优先级：

1. ChatGPT supervised repair：当 ChatGPT MCP 可用且未被平台拦截。
2. local Codex CLI：当需要本地生成补丁、跑测试、隔离 worktree。
3. DeepSeek backup controller：当 ChatGPT 不可用或需要并行复核。
4. Human operator：当涉及 destructive / external effects / ambiguous state。

## 重启策略

重启不是第一动作。只有满足以下条件才建议重启：

- runtime maintenance 已执行但 storage 仍不 ready；
- controller daemon / bridge 状态与进程状态不一致；
- probe 显示 scheduler heartbeat 长时间陈旧；
- 没有安全 metadata candidate 可处理。

建议命令仍由本地 CLI / 用户 / supervisor 执行：

```bash
npm run controller:restart
```

## 自动清理边界

可自动处理：

- worker pid 不存在且超过阈值的 active Local Job -> `orphaned`
- deadline expired 的 running / dispatched job -> `orphaned`
- missing / unreadable `job.json` 的 Local Job dir -> quarantine
- active-index 重建
- runtime storage finalize relocation
- projection rebuild

默认不自动处理：

- pending approval，除非显式 `cancel_pending_approvals=true`
- 源码改动
- Git push / branch delete
- 外部 API 写操作
- 用户仓库非 repo-harness runtime metadata


## Bootstrap fallback

当旧版本 repo-harness 已经卡在 `RUNTIME_STORAGE_NOT_READY`，导致新的 MCP 工具还不能应用时，可以先使用脚本做一次受限 metadata bootstrap：

```bash
bash scripts/bootstrap-runtime-maintenance-recovery.sh /path/to/repo
npm run controller:restart
```

这个脚本只处理 `.ai/harness/local-jobs`：

- stale active jobs -> `orphaned`
- missing / unreadable `job.json` -> `.ai/harness/local-jobs-quarantine`
- rebuild `active-index.json`
- append `.ai/harness/controller/bootstrap-runtime-maintenance.jsonl` audit

它不会修改源码、不会执行 Git、不会 push、不会删除用户文件。

## 失败后继续

每次 maintenance apply 返回 `continuation.afterSuccess`：

1. 重新运行 capability recovery probe。
2. 重试被阻塞的原始 intent。
3. 如果仍失败，再进入 restart fallback。
4. 如果重复失败且 evidence 指向源码缺陷，才创建 source repair task。

## 不变量

- 普通执行链路坏了，不能再用普通执行链路修自己。
- State-only recovery 不修改源码。
- Model repair 只生成补丁或计划，不绕过 repo-harness policy。
- 所有操作必须绑定 repoId，并写 audit / evidence。
