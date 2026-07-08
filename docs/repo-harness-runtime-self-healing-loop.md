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

### Continuation packet contract

Every `failed`, `unknown`, or `waiting_for_user` run should be resumable through a durable continuation packet. The packet is not a user-facing status message; it is the controller handoff that prevents the next attempt from restarting the whole investigation.

```ts
type ContinuationPacket = {
  objective: string;
  repoId: string;
  issueId?: string;
  taskId?: string;
  runId?: string;
  lastKnownPhase: string;
  completedSteps: string[];
  blockedStep: string;
  touchedPaths: string[];
  dirtyProtectedPaths: string[];
  diagnosis: FailureDiagnosis;
  nextSafeActions: string[];
  retryBudget: {
    maxAttempts: number;
    disallowedActions: string[];
  };
  userActionRequired?: {
    reason: string;
    instruction: string;
  };
};
```

Minimum behavior:

- `auth_required`: packet records the blocked tool/provider and requires user re-authorization; retry budget forbids same-agent immediate retry.
- `agent_runtime_failure`: packet records process death/orphan status and points to local reconcile before retry.
- `dirty_worktree_conflict`: packet records dirty protected paths and failed edit operations; integration must switch to patch handoff or manual review.
- `platform_blocked` / payload truncation: packet points to summary/detail pagination or bounded artifact reads instead of repeating the same full response.

1. 重新运行 capability recovery probe。
2. 重试被阻塞的原始 intent。
3. 如果仍失败，再进入 restart fallback。
4. 如果重复失败且 evidence 指向源码缺陷，才创建 source repair task。

## 不变量

- 普通执行链路坏了，不能再用普通执行链路修自己。
- State-only recovery 不修改源码。
- Model repair 只生成补丁或计划，不绕过 repo-harness policy。
- 所有操作必须绑定 repoId，并写 audit / evidence。

## Failure memory

The first implementation should use append-only, controllerHome-backed records rather than a complex knowledge base. The goal is to stop repeated bad retries and make common failure signatures deterministic.

Suggested storage:

```text
_ops/controller-home/repositories/<repo-id>/failure-memory/
  signatures.jsonl
  recipes.json
  recent-failures.json
```

Minimum record:

```json
{
  "signature": "Auth(AuthorizationRequired)",
  "recoveryClass": "auth_required",
  "firstSeenAt": "2026-07-08T03:44:12Z",
  "lastSeenAt": "2026-07-08T03:47:23Z",
  "count": 2,
  "localRecoverable": false,
  "recommendedAction": "request_user_auth",
  "avoidActions": ["retry_same_agent_immediately"]
}
```

Failure memory is advisory. It may suppress clearly wasteful retries, but it must not authorize source changes, token changes, process kills, branch deletion, or external writes.

## 插件授权、浏览器、外部文件的同一恢复循环

这版把常见“不是源码 bug，但阻塞工作流”的问题纳入同一套 Observe → Maintain → Retry → Escalate 循环。

### Gmail / Google Workspace auth

新增：

- `workspace_auth_status`
- `workspace_auth_login_prepare`

`workspace_auth_status` 只返回 readiness、缺失权限和下一步，不返回 token，不读取 secret。

`workspace_auth_login_prepare` 生成本地 OAuth handoff：

- 当 `REPO_HARNESS_GOOGLE_CLIENT_ID` 存在时返回 Google authorization URL；
- 返回需要设置的 token env var 名称，例如 `REPO_HARNESS_GMAIL_ACCESS_TOKEN`；
- 不接收 authorization code；
- 不持久化 client secret、access token、refresh token。

这让 Gmail 阻塞从“插件报错”变成明确 action：

```text
workspace_auth_status
  -> workspace_auth_login_prepare(service="gmail")
  -> local trusted login / env injection
  -> controller restart
  -> retry gmail.list_messages
```

后续如果要做完整 login，可以把 code exchange 放到 Local GUI / CLI，并优先使用 OS keychain；MCP 工具面仍不应接收或保存 secret。

### Browser domain grants

Browser 继续保持低拦截原则：不接受任意 URL，只接受 `target_key + path`。

当出现 `WEB_TARGET_NOT_ALLOWED`、`allowed_domains`、browser domain grant 类错误时，recovery classifier 会返回：

```text
browser_domain_grant_required
```

probe 会推荐：

```text
recovery.browser_domain_access_preview
```

实际使用专用工具：

```text
web_domain_access_preview
web_domain_access_apply
web_targets_list
web_target_snapshot
```

不暴露 submit/delete/payment/upload/download 这类高风险浏览器动作。

### External filesystem grants

新增：

- `external_filesystem_targets_list`
- `external_filesystem_grant_preview`
- `external_filesystem_grant_apply`
- `external_filesystem_text_snapshot`

原则：

- 不接受一次性任意绝对路径读取；
- 先把外部目录转换成命名 target key；
- 只支持 read mode；
- 拒绝 `/`、用户 home 根目录、系统目录、`.ssh`、keychains、云凭据、kube config 等敏感范围；
- 只返回 `<external:key>/relative/path` 预览，不在摘要中暴露完整绝对路径；
- 不提供 external write 工具。

典型流程：

```text
external_filesystem_grant_preview(root_path="/narrow/project/data", grant_key="data", reason="...")
external_filesystem_grant_apply(..., preview_ticket_id="EFG-...", confirm_authorization=true)
external_filesystem_text_snapshot(target_key="data", path="file.txt")
```

当错误包含 absolute path denied / selected path scope denied / outside repository 时，classifier 会返回：

```text
external_filesystem_grant_required
```

## Monitor tick

新增：

```text
self_healing_monitor_tick
```

它是只读聚合工具，不创建 Local Job，不执行 shell。一次 tick 会聚合：

- capability recovery snapshot；
- runtime maintenance status；
- Workspace/Gmail auth status；
- Browser targets；
- External filesystem grants；
- self-healing loop plan；
- next actions。

GUI / scheduler 可以周期性调用它；若未来要自动 apply，仍应只允许低风险、白名单、可审计 maintenance action，并需要独立预算和冷却时间。

## Operator runbook

Use this runbook when repo-harness cannot continue a task normally, or when ChatGPT receives a platform/tooling block while local state may still be recoverable.

1. Run the read-only probe first: `capability_recovery_probe`. Do not restart or retry a failing agent until the failure class is known.
2. For runtime metadata failures such as stale Local Jobs, unreadable job records, stale projections, or runtime-storage blockers, run `runtime_maintenance_status`, then apply only the named safe action with `runtime_maintenance_apply` and matching authorization.
3. For authorized local recovery through `capability_recovery_apply`, use the exact action id as authorization. Mutating actions must remain bounded to repo-harness runtime storage, controller metadata, configured repository records, or handoff artifacts.
4. For `platform_blocked` or `dirty_worktree_conflict`, create a patch handoff instead of repeating the same blocked tool call. Review `.ai/harness/handoff/patch.json` for `diffHash`, `touchedPaths`, `checks`, provenance, and integration notes before applying anything.
5. For `auth_required`, browser domain grants, or external filesystem grants, prepare the typed handoff/preview and stop. Token material, arbitrary URL access, and broad filesystem reads require local user action.
6. Escalate to source repair only after bounded local maintenance and typed grants cannot explain the failure, and the evidence points to a repeatable repo-harness defect.

Automatic recovery is safe only for read-only probes, projection rebuilds, stale Local Job reconciliation, quarantining malformed runtime metadata, and explicitly authorized cleanup of safe repo-harness runtime artifacts. User action is required for secrets, external writes, destructive Git operations, branch deletion, process killing outside the repo-harness supervisor, unclear dirty worktrees, and any operation that would touch non-runtime user files.
