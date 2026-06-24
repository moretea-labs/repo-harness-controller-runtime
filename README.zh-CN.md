# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime：由 ChatGPT 控制、本地运行且可审查的仓库执行桥" width="1280">
</p>

<p align="center">
  <strong>ChatGPT 负责总控，仓库文件负责保存事实。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

`repo-harness Controller Runtime` 是一个本地优先的 ChatGPT 仓库执行桥。它向 ChatGPT 提供有边界的工具，用于读取仓库、管理 Issue 与 Task、执行 Direct Edit、运行命名检查、审查 Diff，并在确有必要时把复杂实现委派给编码 Agent。

它面向真实项目，而不是一次性的聊天会话：计划、任务状态、执行证据、检查结果和 handoff 都与仓库关联，后续会话可以继续推进。

> 当前 package 版本：`1.4.0`
>
> Controller tool surface：`controller-chatgpt-bridge-v8`，schema `10`，surface version `8`

## 为什么需要这个项目

- **ChatGPT 是工作流总控。** ChatGPT 负责阅读、分析、选择执行方式、审查结果和决定下一步。
- **优先 Direct Edit。** 已知的小范围修改使用带 SHA 保护、持久化 Diff、Savepoint、检查和回滚的受限编辑会话。
- **Agent 只是可选执行者。** Codex、Claude、GitHub Copilot 可以处理大范围实现，但不应成为所有任务的默认入口。
- **仓库状态跨会话保留。** Issue、Task、Run、验证证据和 handoff 都有文件化记录。
- **多仓库路由明确。** 每个仓库都有稳定 `repoId`；启用多个仓库时，执行必须明确指定目标。
- **本地运行，HTTPS 接入。** MCP 服务保持监听 loopback，可通过 Cloudflare Tunnel 或 ngrok 等外部隧道提供 HTTPS 地址。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 仓库注册表 | 注册一个或多个 Git checkout，并用稳定 `repoId`、`checkoutId` 定位。 |
| ChatGPT MCP Controller | 提供仓库读取、Issue/Task、Direct Edit、验证、Git、GitHub 同步和执行工具。 |
| Direct Edit 事务 | 支持多 revision、路径和规模限制、SHA 前置校验、Savepoint、Diff、检查与回滚。 |
| Issue → Task → Run | 可恢复、带依赖、带 review 和 verification gate 的长期任务模型。 |
| 本地 Controller UI | 本机查看 Overview、Work、Activity、Settings，以及 Run、编辑、检查和证据。 |
| Runtime 隔离 | Controller 状态保存在源码仓库外部，只在运行时按需关联。 |
| 开源发布工具 | Allowlist 导出、路径与凭据扫描、release surface 检查和 package 校验。 |

## 快速开始

### 1. 前置环境

- Git
- Bun 1.0 或更高版本
- 主要本地工作流面向 macOS / Linux
- 使用内置 Cloudflare 隧道模式时需要 `cloudflared`

### 2. 从源码运行

```bash
git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
```

npm package 正式发布后，可以使用：

```bash
bun add -g repo-harness
repo-harness install
repo-harness doctor
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

临时 Cloudflare 地址：

```bash
cd /path/to/your-project
repo-harness mcp setup chatgpt --repo .
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel quick
```

需要稳定域名时使用 named Cloudflare Tunnel。使用 ngrok 时，先通过 `--tunnel none` 启动本地 MCP，再由 ngrok 转发本地 MCP 端口。完整步骤见使用指南。

## 连接 ChatGPT

1. 准备一个以 `/mcp` 结尾、可通过 HTTPS 访问的 MCP 地址。
2. 在 ChatGPT 中进入 **Settings → Apps & Connectors → Advanced settings**，开启 developer mode。
3. 创建 Connector，填入公开 MCP 地址，例如 `https://mcp.example.com/mcp`。
4. 新建聊天，从输入框附近的工具菜单添加这个 Connector。
5. 在允许写入前，先测试仓库读取、`controller_capabilities` 和 `project_snapshot`。

当前接入流程、权限建议、隧道方案和故障排查见[完整使用指南](docs/public-usage-guide.zh-CN.md#连接-chatgpt)。

## 在 ChatGPT Project 中固定默认仓库

可以。把稳定仓库身份写入 ChatGPT Project instructions，之后该 Project 下的新会话会默认沿用同一套仓库路由规则：

```text
使用 repo-harness 处理仓库工作。
默认 repoId：<repo-harness repo register 返回的 repo-id>
默认 checkoutId：<repo-harness repo register 返回的 checkout-id>

除非我明确选择其他仓库，否则每次调用 repo-harness 工具都传入以上 repoId 和 checkoutId。
开始仓库工作时先调用 controller_capabilities 和 project_snapshot。
已知且有边界的修改优先使用仓库搜索和 Direct Edit；只有确实需要时才启动 Agent。
```

Project instructions 是长期会话默认值，不是服务端权限边界。启用多个仓库时，Controller 仍要求工具调用显式携带 `repoId`，避免误改其他仓库。这是安全设计，不应取消。

## 文档

- [完整使用指南（简体中文）](docs/public-usage-guide.zh-CN.md)
- [Complete usage guide](docs/public-usage-guide.md)
- [ChatGPT MCP 接入参考](docs/repo-harness-chatgpt-mcp-setup.md)
- [ChatGPT Controller 工作流](docs/repo-harness-chatgpt-controller.md)
- [本地执行桥](docs/repo-harness-local-execution-bridge.md)
- [V8 Controller 设计](docs/repo-harness-chatgpt-bridge-v8.md)
- [变更日志](docs/CHANGELOG.md)

## 安全边界

- MCP runtime 保持监听 `127.0.0.1`，只通过受控 HTTPS 隧道或反向代理公开。
- 不要把本地 Controller UI（`127.0.0.1:8766`）暴露到公网。
- 对有写权限的 Connector 使用保守权限配置，并保留修改确认。
- 验证使用命名检查，不开放任意验证命令。
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
bun run test
```
