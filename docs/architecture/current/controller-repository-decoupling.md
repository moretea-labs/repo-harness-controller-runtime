# Controller 与仓库解耦计划

## 背景

repo-harness 已经具备 Repository Registry、`repoId`、`checkoutId` 和 controller home 运行态目录，但历史启动入口仍然以 `--repo` 为中心。这会让 MCP Gateway、Local Bridge 和具体仓库之间的边界变得模糊：服务看起来像是“从某个仓库启动并代表该仓库”，而不是“全局 controller 服务管理多个仓库”。

目标架构应改为：

```text
ChatGPT / Local UI
  -> MCP Gateway / Local Bridge
  -> Controller Runtime
  -> Repository Registry
  -> repoId + checkoutId scoped repository operation
```

`repoRoot` 只应在注册仓库、兼容旧配置、具体执行命令时出现；服务级配置和运行态应逐步迁移到 controller home。

## 命名边界

- **MCP Gateway**：ChatGPT 连接的全局工具网关，不应绑定某个仓库身份。
- **Local Bridge**：本机 Local Workbench/API 兼容名称，负责本地 GUI、移动 intent、本地任务入口。
- **Repository**：被注册、选择、执行的工作目标。
- **repoId / checkoutId**：所有仓库级操作的显式作用域。
- **repoRoot**：仓库本地路径，只在注册和执行层使用。

## 分阶段改动

### Phase 1：文档与入口语义收敛

- 将 `--repo` 描述为兼容默认仓库和配置引导入口。
- 文档中明确 MCP Gateway / Local Bridge 是全局 controller 服务。
- GUI 和用户文案避免把 Local Bridge 暴露成用户需要理解的概念。

### Phase 2：Local Bridge 支持 repoId-scoped 业务入口

先不迁移存储，降低风险。

- `LocalBridgeServerOptions` 保留 `repoRoot` 作为兼容 fallback。
- 新增 `controllerHome` 和 `defaultRepoId` 选项。
- `/api/snapshot`、`/api/user-snapshot` 支持 `?repoId=` 和 `?checkoutId=`。
- 新增 `/api/repositories/:repoId/snapshot`。
- 新增 `/api/repositories/:repoId/user-snapshot`。
- 仓库列表按 selected repoId 标记 current，而不是只能按启动 repoRoot 判断。
- completion、progress、governance、assistant readiness/intent 和 recovery probe/plan/apply 入口通过 request 解析目标仓库。
- assistant inbox/routines/memory、runtime cleanup、mobile devices 入口通过 request 解析目标仓库。
- project-state、issue focus、launch/archive/restore、task launch/verify/accept/request-changes/cancel/dependencies 和 timeline 入口通过 request 解析目标仓库。
- task detail、worklog export、edit session list/detail/diff/savepoint/verify/finalize/rollback 入口通过 request 解析目标仓库。
- plugin、GitHub sync、browser target、DeepSeek handoff/request 入口通过 request 解析目标仓库。
- local jobs 与 runs 的 detail/log/events/finish/diff/integrate/cancel/retry 入口通过 request 解析目标仓库。

### Phase 3：迁移服务级运行态到 controllerHome

后续迁移应拆独立任务，避免和 UI/执行逻辑混在一起。

MCP service-level 配置以 controller home 为 authority：

```text
controllerHome/
  mcp/mcp.local.json
  mcp/mcp.runtime.json
  mcp/mcp.oauth.json
  mcp/mcp.oauth-tokens.json
  mcp/mcp.tokens.json
  local-bridge/server.json
  local-bridge/sessions.json
  plugins/*.json
```

继续 repo-scoped：

```text
controllerHome/repositories/<repoId>/runs
controllerHome/repositories/<repoId>/local-jobs
controllerHome/repositories/<repoId>/worktrees
controllerHome/repositories/<repoId>/edit-sessions
controllerHome/repositories/<repoId>/artifacts
controllerHome/repositories/<repoId>/controller-state
```

仓库目录可继续保留 repo policy、兼容 symlink / projection，以及 MCP 旧版本 fallback：

```text
.repo-harness/mcp.policy.json
.repo-harness/mcp.local.json              # legacy service config fallback
.repo-harness/mcp.tokens.json             # legacy bearer fallback
.repo-harness/mcp.oauth.json              # legacy OAuth passphrase fallback
.repo-harness/mcp.oauth-tokens.json       # legacy OAuth token-store fallback
.repo-harness/mcp.runtime.json            # legacy runtime fallback
.repo-harness/plugins/*.json
.repo-harness/external-filesystem-grants.json
.ai/harness/*  # compatibility/projection only
```

## 兼容策略

- 多仓库启用时，MCP 工具和 Local Bridge 写操作必须显式携带 `repoId`，不能靠启动目录猜测。
- 单仓库启用时可以保留 sole repository fallback。
- `--repo` 在迁移完成前继续可用，但不应被描述为服务身份。
- MCP service-level 配置读取顺序为 controllerHome 优先、repo-local `.repo-harness/mcp.*` legacy fallback 其次；新 controller profile setup/restart/keepalive 写入 controllerHome。

## 当前完成状态

- 已新增 Local Bridge request-level repo selection helper。
- 已让 `/api/snapshot` 和 `/api/user-snapshot` 支持 repoId / checkoutId。
- 已新增 repoId-scoped snapshot 和 user-snapshot endpoints。
- 已将主要 Local Bridge 业务 API 改为 request-scoped repo selection，包括 completion、progress、governance、assistant、recovery、project-state、issue/task、timeline、worklog、edit-session、plugin、GitHub、toolchain、local jobs 和 runs。
- 已将 README 的启动说明改为 registry-first / compatibility `--repo` 语义。
- MCP HTTP service-level 配置、auth token、OAuth passphrase/token store、public origin 和 runtime state 已迁移到 controllerHome-backed storage，并保留 `.repo-harness/mcp.*` legacy fallback。
- 当前剩余的 `options.repoRoot` 用法集中在启动默认仓库 fallback、启动时 reconcile、stream signature、runtime policy/mobile intent 兼容入口、仓库列表默认选择和 server close/cache cleanup。

## 仍未完成的架构收口

### 1. MCP Gateway 身份边界复核

已复核 MCP Gateway 的 controller profile 主路径：

- `src/cli/mcp/server.ts` 在 controller profile 下创建 multi-repository context；`--repo .` 会被降级为未指定 repo，避免把当前目录强行当作服务身份。
- `src/cli/mcp/multi-repository.ts` 会给工具 schema 注入 `repo_id` / `checkout_id`，并在调用时通过 Repository Registry 解析目标仓库。
- 未传 `repo_id` 时只允许 explicit repository fallback 或 sole-repository fallback；多仓库场景应返回解析错误。
- MCP tool 调用会使用目标仓库的 `repository.canonicalRoot` 构造 scoped context，并把 repository/runtimeStorage envelope 写回结果。
- `src/cli/mcp/repository-tools.ts` 的 repository/git/safe-patch/command tools 已按 `repo_id` / `checkout_id` 解析目标仓库，并把 command job payload 绑定到 `repoId` / `checkoutId`。

durable router 和 runtime gateway 主路径均已完成补充复核：

- `src/runtime/gateway/mcp/router.ts` 会对可持久化 MCP 调用执行 `resolveRepositorySelection`，将 `repoId` / `checkoutId` 写入 ExecutionJob，并通过 `repositoryScopedToolArgs` 注入目标仓库上下文。
- controller-scoped repository tools 仅限 `repository_register` 以及未指定仓库的 `repository_workbench`；其他 repository tools 会解析目标仓库。
- `src/runtime/gateway/mcp/runtime-tools.ts` 的 tool definitions 暴露 `repo_id`，执行 helper `selected(ctx,args)` 使用 `repo_id` / `checkout_id` / explicit repository / sole-repository fallback 统一解析目标仓库；已抽查 work/git/local-bridge/plugin/recovery/iOS/review/runtime-cleanup 等工具段，均通过目标 repository 执行。

### 2. 服务级运行态迁移

MCP Gateway 的 service-level runtime/config 已迁移到 `controllerHome/mcp/mcp.*`，并将 repo-local `.repo-harness/mcp.*` 降级为 legacy fallback。Local Bridge 仍保留 `options.repoRoot` 用于启动级 reconcile、stream signature、runtime policy 和缓存清理。短期允许作为 compatibility default；长期应迁移为 controller-home/global runtime state，并让 `repoRoot` 只出现在 repository registration 和 repository-scoped execution 层。

### 3. 最小多仓库验收

不需要膨胀测试，但至少应做以下针对性验证：

- 注册两个仓库后，分别请求 snapshot / issue / run / plugin API，不串仓。
- `repoId`、`checkoutId`、默认 fallback 三条路径行为明确且可解释。
- GUI 切换仓库后，所有业务请求携带选中的 repoId。
- Local Bridge 重启后，默认仓库只影响初始选择，不影响 request-scoped API。

## 后续验收点

- GUI 切换仓库后，请求应带 `repoId`，而不是依赖启动目录。
- 多仓库注册时，Local Bridge 首页应能显示所有仓库，并正确标记当前选择。
- MCP Gateway 启动和 ChatGPT Connector 配置应逐步不再要求用户位于某个仓库目录。
- repo-local `.repo-harness/mcp.*` 文件只作为 legacy fallback；后续可在迁移窗口结束后进一步降级提示或清理。
