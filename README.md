# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime：由 ChatGPT 控制、本地运行且可审查的仓库执行桥" width="1280">
</p>

<p align="center">
  <strong>ChatGPT 负责总控，仓库文件负责保存事实。</strong>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <a href="README.md">简体中文</a>
</p>

`repo-harness Controller Runtime` 是一个本地优先的 ChatGPT 仓库执行桥。它向 ChatGPT 提供有边界的工具，用于读取仓库、管理 Issue 与 Task、执行 Direct Edit、运行命名检查、审查 Diff，并在确有必要时把复杂实现委派给编码 Agent。

它面向真实项目，而不是一次性的聊天会话：计划、任务状态、执行证据、检查结果和 handoff 都与仓库关联，后续会话可以继续推进。当前运行时采用薄网关、持久 Job、全局调度器、每仓库 Repo Actor、独立 Worker 和 Evidence Plane。

新用户建议按这个顺序进入：

1. [公开使用指南](docs/public-usage-guide.zh-CN.md)
2. [安装并启动](docs/tutorials/01-install-and-start.zh-CN.md)
3. [连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md)
4. [完成第一个仓库任务](docs/tutorials/03-first-repository-task.zh-CN.md)

> 当前 package 版本：`1.4.0-rc.1`（npm dist-tag：`next`）
>
> Controller tool surface：`controller-chatgpt-bridge-v8`，schema `10`，surface version `8`

当前公开发行线仍是 RC；本文档描述的是当前实现与安装路径，不应被解读为稳定 `1.4.0` 已经发布。

## 为什么需要这个项目

- **ChatGPT 是工作流总控。** ChatGPT 负责阅读、分析、选择执行方式、审查结果和决定下一步。
- **优先 Direct Edit。** 已知的小范围修改使用带 SHA 保护、持久化 Diff、Savepoint、检查和回滚的受限编辑会话。
- **Agent 只是可选执行者。** Codex、Claude、GitHub Copilot 可以处理大范围实现，但不应成为所有任务的默认入口。
- **仓库状态跨会话保留。** Issue、Task、Run、验证证据和 handoff 都有文件化记录。
- **多仓库路由明确。** 每个仓库都有稳定 `repoId`；启用多个仓库时，执行必须明确指定目标。
- **本地运行，HTTPS 接入。** MCP 服务保持监听 loopback；推荐用 Tailscale Funnel 或 Cloudflare named tunnel 暴露稳定 HTTPS `/mcp` 地址，避免临时隧道地址变化。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 仓库注册表 | 注册一个或多个 Git checkout，并用稳定 `repoId`、`checkoutId` 定位。 |
| ChatGPT MCP Controller | 提供仓库读取、Issue/Task、Direct Edit、验证、Git、GitHub 同步和执行工具。 |
| Direct Edit 事务 | 支持多 revision、路径和规模限制、SHA 前置校验、Savepoint、Diff、检查与回滚。 |
| Issue → Task → Run | 可恢复、带依赖、带 review 和 verification gate 的长期任务模型。 |
| 本地 Controller UI | 仅限本机访问的执行助手控制台，包含指挥中心（Command Center）、审批与决定、当前任务、能力 / 插件、模型与工具、系统状态、仓库和高级诊断。 |
| 有界结果与证据 | 长任务先落成 durable Job / Run，MCP 和 UI 默认返回摘要与有界预览，需要时再读取证据与 artifact。 |
| Runtime 控制面 | Thin Gateway、Global Scheduler、每仓库 Repo Actor、ExecutionJob、Claim、Lease、Fencing 和独立 Worker。 |
| 自修复闭环 | `self_healing_monitor_tick` 汇总 runtime storage、Local Job、Gmail auth、Browser domain、外部文件 target 和模型修复兜底；`runtime_maintenance_status/apply` 可绕过普通执行链路做本地 metadata 修复。 |
| 自动化治理 | 有界 Schedule/Decision/Occurrence、Candidate Finding、Portfolio DAG/Saga 和 Release Gate。 |
| Runtime 隔离 | Controller 状态保存在源码仓库外部，只在运行时按需关联。 |
| 开源发布工具 | Allowlist 导出、路径与凭据扫描、release surface 检查和 package 校验。 |


## 自修复闭环

repo-harness 区分两类问题：

- **本地运行态问题**：例如 `RUNTIME_STORAGE_NOT_READY`、`local-jobs legacy-active`、stale active Local Job、unreadable `job.json`。这些由内置 maintenance executor 处理，不依赖 `repository_command_execute`，也不会创建新的 Local Job。
- **源码缺陷问题**：例如 recovery action 自身 TypeError、重复出现的断言失败。只有本地维护和重启兜底无效后，才把修复方案交给 ChatGPT / local Codex CLI / DeepSeek backup controller 生成补丁。

常用入口：

```text
self_healing_monitor_tick
runtime_maintenance_status
runtime_maintenance_apply
workspace_auth_status
workspace_auth_login_prepare
web_domain_access_preview/apply
external_filesystem_grant_preview/apply
external_filesystem_text_snapshot
self_healing_loop_plan
```

详细设计见 [`docs/repo-harness-runtime-self-healing-loop.md`](docs/repo-harness-runtime-self-healing-loop.md)。

## 快速开始

### 1. 前置环境与平台选择

- Git
- Node.js 20.10 或更高版本
- npm 或 Bun 1.0+；源码开发推荐 Bun
- macOS 和现代 Linux 完整支持；Windows 完整工作流推荐 WSL2
- Windows 原生 PowerShell 当前为预览路径，覆盖安装、doctor、仓库注册/读取和可移植 Controller 操作

详细范围见[平台支持说明](docs/operations/platform-support.zh-CN.md)、[功能与配置层级](docs/operations/features.zh-CN.md)和[完整安装教程](docs/tutorials/01-install-and-start.zh-CN.md)。

### 2. 安装或从源码运行

```bash
npm install -g @moretea-labs/repo-harness-controller@next
# 或：bun add -g @moretea-labs/repo-harness-controller@next
repo-harness install --no-cli
repo-harness doctor
```

npm 包名是 `@moretea-labs/repo-harness-controller`，安装后仍提供 `repo-harness` 和 `repo-harness-hook` 两个 CLI。当前 RC 使用 `next` 标签，不会占用稳定版 `latest`。

从源码运行：

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
```

### 3. 接入已有仓库

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
```

直接从本源码仓库运行时，将 `repo-harness` 替换为：

```bash
bun run src/cli/index.ts
```

### 4. 注册仓库

```bash
repo-harness repo register /path/to/your-project --name my-project --json
repo-harness repo list --json
```

保存返回的 `repoId`。ChatGPT 工具后续会用它作为稳定的执行目标身份。

### 5. 启动 ChatGPT Controller 地址

先把仓库注册为 Controller 管理目标，并生成 ChatGPT MCP 配置：

```bash
repo-harness repo register /path/to/your-project
repo-harness mcp setup chatgpt --repo /path/to/your-project
```

MCP 默认只监听本机：

```text
http://127.0.0.1:8765/mcp
```

ChatGPT 不能直接访问本机 loopback，因此需要一个稳定的公网 HTTPS `/mcp` 地址。当前推荐顺序：

1. **Tailscale Funnel**：不买域名、不配 DNS，适合个人长期自用。
2. **Cloudflare named tunnel + 自有域名**：最标准，适合长期团队或公开域名。
3. **ngrok/Cloudflare quick tunnel**：适合临时测试，不建议长期放到 ChatGPT Project Connector。

Tailscale Funnel 示例：

```bash
# 第一次需要安装 Tailscale 并登录
brew install --cask tailscale
tailscale up

# 开启公网 HTTPS Funnel 到本地 MCP 端口
tailscale funnel --bg 8765
tailscale funnel status
```

如果输出类似：

```text
https://your-machine.your-tailnet.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8765
```

则 ChatGPT Connector 填：

```text
https://your-machine.your-tailnet.ts.net/mcp
```

并用同一 endpoint 启动 repo-harness：

```bash
repo-harness mcp keepalive --repo /path/to/your-project --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel tailscale \
  --public-endpoint https://your-machine.your-tailnet.ts.net/mcp
```

完整步骤、Cloudflare named tunnel 和 ngrok 兼容方式见使用指南。

### 6. macOS 一键生命周期入口

在源码仓库中，可以用统一入口管理 detached Controller 栈的启动、停止、状态、日志和安全重启：

```bash
bun run controller:start
bun run controller:status
bun run controller:logs
bun run controller:restart
bun run controller:stop
```

不走 `package.json` script 时，也可以直接调用：

```bash
bash scripts/controller-runtime.sh start --repo .
bash scripts/controller-runtime.sh status --repo .
```

`start` 会在真正拉起 daemon、MCP Gateway 和 Local Bridge 之前，先做 Bun、兼容仓库根目录、包版本、PID 状态、MCP / Local Controller 端口、controller home 以及 detached repo-harness 孤儿进程检查。长期架构上，MCP Gateway 和 Local Bridge 是全局 controller 服务，仓库通过 registry、`repoId` 和 `checkoutId` 被选择；`--repo` 只作为兼容默认仓库和配置引导入口。日志默认写到 `.ai/local/logs/repo-harness-controller.log`。

MCP 的 service 级配置、认证与运行态统一以 Controller Home 为主，包括 `controllerHome/mcp/mcp.local.json`、`mcp.tokens.json`、`mcp.oauth.json`、`mcp.oauth-tokens.json` 和 `mcp.runtime.json`。对应的 repo-local `.repo-harness/mcp.local.json`、`.repo-harness/mcp.tokens.json`、`.repo-harness/mcp.oauth.json`、`.repo-harness/mcp.oauth-tokens.json`、`.repo-harness/mcp.runtime.json` 仅用于 legacy fallback；仓库级 `.repo-harness/mcp.policy.json` 仍负责收窄仓库访问范围。迁移说明见 [MCP 工具面与兼容策略](docs/operations/mcp-tool-exposure.md)。

## 连接 ChatGPT

新用户从 [中文教程：连接 ChatGPT](docs/tutorials/02-connect-chatgpt.zh-CN.md) 开始。连接后先调用 `rh_status`，再用 `rh_context` 获取当前仓库上下文。默认 `advanced` 是固定、可修复的工具 schema。日常优先使用 `rh_status`、`rh_access`、`rh_context`、`rh_work` 和 `rh_inbox`，同时 Direct Edit、命令、Git、Agent、Campaign、iOS、插件、artifact 和恢复工具无需切换权限即可使用。`core` 是兼容别名，`full` 是全量历史兼容工具面。

如果多仓库同时注册，保持 `repoId` 和 `checkoutId` 显式传递。Controller 是全局服务，但仓库写操作仍按仓库与 checkout 身份受限路由；公网 MCP endpoint 与 `127.0.0.1:8766` 上仅限本机访问的 Local Controller UI 是两个不同入口。

完整文档入口见 [docs/README.md](docs/README.md)；英文用户切换到 [README.en.md](README.en.md)。

## 在 ChatGPT Project 中固定默认仓库

可以。把稳定仓库身份写入 ChatGPT Project instructions，之后该 Project 下的新会话会默认沿用同一套仓库路由规则：

```text
使用 repo-harness 处理仓库工作。
默认 repoId：<repo-harness repo register 返回的 repo-id>
默认 checkoutId：<repo-harness repo register 返回的 checkout-id>

除非我明确选择其他仓库，否则每次调用 repo-harness 工具都传入以上 repoId 和 checkoutId。
开始仓库工作时先调用 rh_status 和 rh_context。
通过 rh_work 执行有边界的修改；只有确实需要时才委派给 Agent。
```

Project instructions 是长期会话默认值，不是服务端权限边界。启用多个仓库时，Controller 仍要求工具调用显式携带 `repoId`，避免误改其他仓库。这是安全设计，不应取消。

## 文档

- [公开文档中心](docs/README.md)
- [中文快速教程](docs/tutorials/README.zh-CN.md)
- [English tutorials](docs/tutorials/README.md)
- [当前架构权威入口](docs/architecture/index.md)

历史设计和研究记录会明确标注为非运行时权威；普通用户不需要阅读它们即可完成安装和首个任务。

## 安全边界

- MCP runtime 保持监听 `127.0.0.1`，只通过受控 HTTPS 隧道或反向代理公开。
- 不要把本地 Controller UI（`127.0.0.1:8766`）暴露到公网。
- 对有写权限的 Connector 使用保守权限配置，并保留修改确认。
- 验证使用命名检查，不开放任意验证命令。
- 不要把 `502`、连接中断或大结果截断直接当作“写操作失败”；优先回到 Job / Run / 证据摘要确认真实状态。
- 接受 Task 或 finalize Direct Edit 前，先审查 Diff 和验证证据。
- 不得提交 Controller runtime state、本地日志、凭据、Token、worktree 或 edit-session 数据。

## 上游项目与许可证

本项目基于 [AncientTwo/repo-harness](https://github.com/AncientTwo/repo-harness) 进行大幅修改。原项目提供了 repo-local workflow 基础；本仓库进一步实现并适配了 ChatGPT Controller、仓库注册表、runtime-storage 隔离、Direct Edit、治理、验证、本地执行桥和开源发布工具。

项目使用 MIT License，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。对上游项目的引用不表示上游作者为本衍生项目背书。

## 发布状态

本仓库正在整理为可独立发布的开源发行版。发布前运行：

```bash
bun run check:release-surface
bun run check:public-export
bun run check:type
bun run check:runtime-architecture
bun run check:mcp-compatibility
bun run smoke:runtime-recovery
bun run smoke:schedule-engine
bun run smoke:runtime-control-plane
bun run smoke:mcp-http-runtime
bun run test
```
