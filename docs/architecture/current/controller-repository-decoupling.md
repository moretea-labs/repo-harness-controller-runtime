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

### Phase 2：Local Bridge 支持 repoId-scoped 读取入口

先不迁移存储，降低风险。

- `LocalBridgeServerOptions` 保留 `repoRoot` 作为兼容 fallback。
- 新增 `controllerHome` 和 `defaultRepoId` 选项。
- `/api/snapshot`、`/api/user-snapshot` 支持 `?repoId=` 和 `?checkoutId=`。
- 新增 `/api/repositories/:repoId/snapshot`。
- 新增 `/api/repositories/:repoId/user-snapshot`。
- 仓库列表按 selected repoId 标记 current，而不是只能按启动 repoRoot 判断。

### Phase 3：迁移服务级运行态到 controllerHome

后续迁移应拆独立任务，避免和 UI/执行逻辑混在一起。

建议迁移到 controller home：

```text
controllerHome/
  mcp/local.json
  mcp/runtime.json
  mcp/oauth.json
  mcp/tokens.json
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

仓库目录可继续保留 repo policy 和兼容 symlink / projection：

```text
.repo-harness/mcp.policy.json
.repo-harness/plugins/*.json
.repo-harness/external-filesystem-grants.json
.ai/harness/*  # compatibility/projection only
```

## 兼容策略

- 多仓库启用时，MCP 工具和 Local Bridge 写操作必须显式携带 `repoId`，不能靠启动目录猜测。
- 单仓库启用时可以保留 sole repository fallback。
- `--repo` 在迁移完成前继续可用，但不应被描述为服务身份。
- 迁移运行态前，所有新增 API 应先接受 repoId 并内部解析到 `repository.canonicalRoot`。

## 当前完成状态

- 已新增 Local Bridge request-level repo selection helper。
- 已让 `/api/snapshot` 和 `/api/user-snapshot` 支持 repoId / checkoutId。
- 已新增 repoId-scoped snapshot 和 user-snapshot endpoints。
- 已将 README 的启动说明改为 registry-first / compatibility `--repo` 语义。

## 后续验收点

- GUI 切换仓库后，请求应带 `repoId`，而不是依赖启动目录。
- 多仓库注册时，Local Bridge 首页应能显示所有仓库，并正确标记当前选择。
- MCP Gateway 启动和 ChatGPT Connector 配置应逐步不再要求用户位于某个仓库目录。
- 运行态迁移完成后，删除或降级仓库目录中的 MCP token/runtime 文件依赖。
