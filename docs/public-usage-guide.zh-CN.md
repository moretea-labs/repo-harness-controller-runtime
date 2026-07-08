# repo-harness Controller Runtime：完整使用指南

[简体中文](public-usage-guide.zh-CN.md) · [English](public-usage-guide.md)

本文档说明 `repo-harness Controller Runtime` 1.4.0 面向公开用户的安装、接入和日常使用方式。

## 1. 工作模型

```text
ChatGPT
  ↓ HTTPS MCP
repo-harness Controller（本机）
  ├─ 仓库读取
  ├─ Direct Edit 事务
  ├─ Issue / Task / Run
  ├─ 命名验证检查
  └─ 可选编码 Agent
        ↓
已注册的 Git 仓库
```

ChatGPT 是总控；repo-harness 提供受限仓库能力和持久化状态；编码 Agent 只是可选实现工具，不是默认工作流所有者。

## 2. 环境要求

必须：

- Git
- Bun 1.0 或更高版本
- 一个需要管理的本地 Git 仓库
- 可以创建 developer-mode Connector 的 ChatGPT 账号

可选：

- Tailscale CLI / macOS App：推荐的个人稳定公网入口，可用 Funnel 提供 `*.ts.net` HTTPS 地址
- `cloudflared`：使用 Cloudflare quick/named tunnel；named tunnel 适合自有域名长期使用
- ngrok：兼容外部临时或保留域名 HTTPS 隧道，不建议长期依赖免费临时地址
- Codex、Claude、GitHub Copilot：启用 Agent 委派时使用
- GitHub CLI：同步 GitHub Issue/Project 时使用

## 3. 安装

### 3.1 从源码运行

npm 正式发布前也可使用：

```bash
git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
```

从源码执行本文命令时，可将 `repo-harness` 替换为：

```bash
bun run /path/to/repo-harness-controller-runtime/src/cli/index.ts
```

### 3.2 安装已发布 package

package 正式发布后：

```bash
bun add -g repo-harness
repo-harness install
repo-harness doctor
```

`install` 负责宿主级运行时初始化，不会自动接入机器上的所有仓库。

## 4. 接入已有仓库

先预览：

```bash
repo-harness adopt --repo /path/to/project --dry-run
```

确认后应用：

```bash
repo-harness adopt --repo /path/to/project
```

接入会创建或刷新 repo-local workflow，包括计划、任务、上下文、hook、检查和 handoff。目标仓库已有同名自定义文件时，必须先检查 dry-run。

## 5. 注册仓库

```bash
repo-harness repo register /path/to/project --name my-project --json
```

查看和校验：

```bash
repo-harness repo list --json
repo-harness repo inspect <repo-id> --json
repo-harness repo validate <repo-id> --json
```

返回值含义：

- `repoId`：仓库稳定身份；同一 canonical remote 的不同 checkout 共用仓库身份。
- `checkoutId`：某个本地 checkout 的身份。
- repository path：本机路径，路径变化不一定改变 canonical repository identity。

只有一个 enabled repository 时，部分工具可以自动选择；启用多个仓库时必须传 `repoId`。`repo focus` 只是交互界面偏好，不是执行安全边界。

## 6. 启动本地 Controller

在目标仓库生成 ChatGPT setup：

```bash
cd /path/to/project
repo-harness mcp setup chatgpt --repo .
```

只启动本地服务：

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel none
```

默认本地地址：

- MCP HTTP：`http://127.0.0.1:8765/mcp`
- 本地 Controller UI：`http://127.0.0.1:8766/`

Controller UI 必须保持本机私有，只公开 MCP endpoint。

## 7. 通过 HTTPS 暴露 MCP

ChatGPT 需要通过 HTTPS 访问 MCP。选择一种方案即可。当前推荐顺序：

| 方案 | 适用场景 | 是否推荐长期使用 |
| --- | --- | --- |
| Tailscale Funnel | 个人自用；不想买域名、不想配 DNS | 推荐 |
| Cloudflare named tunnel + 自有域名 | 团队、长期固定域名、标准反向代理 | 推荐 |
| Cloudflare quick tunnel | 快速试通 | 仅临时 |
| ngrok 外部隧道 | 已有 ngrok 账号或 reserved domain | 可选；免费临时地址不推荐长期 |

### 7.1 推荐：Tailscale Funnel 稳定公网入口

Tailscale Funnel 可以把本地 `127.0.0.1:8765` 暴露成公网 HTTPS `*.ts.net` 地址，适合个人长期使用 repo-harness MCP：

```text
ChatGPT Connector
  → https://your-machine.your-tailnet.ts.net/mcp
  → Tailscale Funnel
  → http://127.0.0.1:8765/mcp
  → repo-harness MCP
```

第一次安装并登录：

```bash
brew install --cask tailscale
tailscale up
```

开启 Funnel：

```bash
tailscale funnel --bg 8765
tailscale funnel status
```

如果 `tailscale funnel --bg 8765` 提示需要在浏览器启用 Funnel，打开它输出的 Tailscale 登录链接并批准。成功后应看到类似：

```text
https://your-machine.your-tailnet.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8765
```

此时 ChatGPT Connector URL 是：

```text
https://your-machine.your-tailnet.ts.net/mcp
```

启动 repo-harness MCP：

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel tailscale \
  --public-endpoint https://your-machine.your-tailnet.ts.net/mcp
```

也可以把 endpoint 写入配置，供 `controller-runtime.sh restart` 后继续沿用：

```bash
repo-harness mcp setup chatgpt --repo . \
  --endpoint https://your-machine.your-tailnet.ts.net/mcp
```

稳定性检查：

```bash
tailscale funnel status
scripts/controller-runtime.sh status
```

期望输出包含：

```text
MCP: port=8765 health=ok
Local Controller: port=8766 health=ok
external tunnel manager: disabled
https://your-machine.your-tailnet.ts.net (Funnel on)
```

注意：只公开 `8765` 的 MCP，不要公开 `8766` 的本地 Controller UI。

### 7.2 Cloudflare named tunnel + 自有域名

域名已托管到 Cloudflare 时推荐使用：

```bash
cloudflared tunnel login
cloudflared tunnel create repo-harness-mcp
cloudflared tunnel route dns repo-harness-mcp mcp.example.com
```

启动 named tunnel：

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel named \
  --cloudflare-tunnel-name repo-harness-mcp \
  --public-endpoint https://mcp.example.com/mcp
```

需要时重新生成稳定 endpoint 配置：

```bash
repo-harness mcp setup chatgpt --repo . \
  --endpoint https://mcp.example.com/mcp
```

Cloudflare 官方文档：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>

### 7.3 Cloudflare quick tunnel

适合快速测试，地址临时生成：

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel quick
```

命令会识别生成的 `trycloudflare.com` 地址。把输出中以 `/mcp` 结尾的 URL 填到 ChatGPT Connector。

限制：

- 重启后 hostname 可能变化；
- 不适合作为长期 ChatGPT Project Connector；
- 地址变化后需要更新或重建 Connector。

### 7.4 ngrok 外部隧道

之前提到的“grok 反代”在本文按产品名 **ngrok** 处理。ngrok 不是 repo-harness 内置 tunnel mode，需要单独运行。

终端 A：

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel none
```

终端 B：

```bash
ngrok http 8765
```

如果 ngrok 输出 `https://example.ngrok.app`，Connector URL 填：

```text
https://example.ngrok.app/mcp
```

把 endpoint 写入生成配置：

```bash
repo-harness mcp setup chatgpt --repo . \
  --endpoint https://example.ngrok.app/mcp
```

免费临时域名可能变化。长期使用优先选择 Tailscale Funnel、Cloudflare named tunnel、ngrok reserved/static domain 或其他稳定 HTTPS 反向代理。

ngrok 官方文档：<https://ngrok.com/docs/getting-started/>

### 7.5 其他反向代理要求

- 将 `/mcp` 转发到 `http://127.0.0.1:8765/mcp`；
- 只有监控需要时才转发 `/health`；
- 支持 streaming 和长连接 HTTP response；
- 不得公开 `8766` 或本地 Controller UI；
- 对可写 MCP server 增加合适的认证和访问控制；
- 不要把 Token、密钥放入 URL query 或公开文档。

## 8. 连接 ChatGPT

当前 OpenAI developer 接入流程：

1. 打开 ChatGPT Settings。
2. 进入 **Apps & Connectors → Advanced settings**，开启 developer mode。
3. 进入 **Connectors**，点击 **Create**。
4. 填写名称和清晰的功能说明。
5. Connector URL 填公开 HTTPS `/mcp` endpoint。
6. 创建后确认工具列表能够正常加载。
7. 新建聊天，从输入框附近的工具菜单添加该 Connector。

OpenAI 官方参考：<https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>

第一次建议只读测试：

```text
调用 controller_capabilities 和 project_snapshot，目标使用我的默认 repoId，不要修改文件。
```

初期权限建议：

- 部署验证阶段使用 **Always ask**；或
- 只读能力稳定后使用 **Ask before making changes**。

Controller tool surface、工具描述或 MCP URL 升级后，应在 ChatGPT 中 Refresh Connector metadata；如果 URL origin 从 ngrok 切到 Tailscale/Cloudflare，通常需要重新连接或重新授权。

## 9. 在 ChatGPT Project 固定默认仓库

可以把仓库身份和工作规则写入 Project instructions，这样不用每次会话重复说明。

模板：

```text
本 Project 的所有仓库工作都使用 repo-harness。

默认仓库：
- repoId：<repo-harness repo register 返回的 repo-id>
- checkoutId：<repo-harness repo register 返回的 checkout-id>

规则：
1. 除非我明确选择其他仓库，否则每个 repository-scoped repo-harness 工具都传入以上 repoId 和 checkoutId。
2. 需要治理上下文时，先调用 controller_capabilities、project_snapshot、get_project_governance、list_edit_sessions 和 list_checks。
3. 已知且有边界的修改优先使用 search_repository/read_repository_file 和 Direct Edit。
4. 除非任务范围过大、无法安全 Direct Edit，或我明确要求，否则不要启动 Codex、Claude、Copilot。
5. 未得到当前请求中的明确授权，不得 push、merge、删除分支、改写历史或执行其他破坏性操作。
6. 现有 working-tree 变更视为用户工作；除非我明确要求，不得覆盖。
```

需要理解的限制：

- Project instructions 约束 ChatGPT 行为，不改变服务端权限。
- Connector 仍需要在当前会话中可用。
- 多仓库 Controller 仍应显式传 `repoId`。
- `repo focus` 不能替代明确仓库路由。

## 10. 常用工作方式

### 只读仓库审计

```text
使用默认 repoId 调用 repo-harness。读取 controller_capabilities、project_snapshot、Git 状态和相关文件，只输出结论，不修改。
```

### 小范围修改

```text
先读取相关文件并 assess_work_request。范围已知且有边界时使用 Direct Edit，展示持久化 Diff，运行命名检查，通过后再 finalize。
```

### 大型治理任务

```text
检查仓库和当前 Issue，把工作拆为有依赖的 Task。计划和路径边界可审查前，不要启动 Agent。
```

### 继续现有 Issue

```text
读取 project_snapshot、get_project_governance、当前 Issue、最近 edit session 和 checks。优先继续最低风险 ready 工作，不要无理由重启已完成或已取消的 Agent。
```

## 11. 核心命令

| 命令 | 用途 |
| --- | --- |
| `repo-harness doctor` | 只读检查安装和宿主环境。 |
| `repo-harness install` | 初始化宿主级 runtime 和 adapters。 |
| `repo-harness adopt --repo <path>` | 安装或刷新 repo-local workflow。 |
| `repo-harness repo register <path>` | 注册仓库并返回稳定身份。 |
| `repo-harness repo list` | 查看已注册仓库和当前 UI focus。 |
| `repo-harness repo validate <repoId>` | 校验仓库身份、checkout、runtime storage 和迁移状态。 |
| `repo-harness mcp setup chatgpt --repo <path>` | 生成 ChatGPT Connector setup。 |
| `repo-harness mcp keepalive ...` | 托管 MCP、local UI 和可选 Cloudflare tunnel。 |
| `repo-harness repo rollout ...` | 刷新已注册仓库并重启配置的 Controller。 |

## 12. 安全检查表

公开 endpoint 前确认：

- [ ] MCP 只监听 `127.0.0.1`。
- [ ] 公网只暴露 MCP endpoint。
- [ ] 本地 UI 未公开。
- [ ] Token、凭据没有进入 URL、README 示例、日志或 Git 历史。
- [ ] ChatGPT Connector 对修改操作保留确认。
- [ ] 仓库写入路径有边界。
- [ ] 命名检查已配置并通过。
- [ ] runtime 目录、日志、worktree、edit session、controller state 已 ignore 且不再 tracked。
- [ ] 发布前通过 `bun run check:release-surface` 和 `bun run check:public-export`。

## 13. 故障排查

### ChatGPT 无法连接

- 确认 URL 使用 HTTPS 且以 `/mcp` 结尾；
- 确认 tunnel 仍在运行；
- 先检查本地 health；
- 确认反向代理支持 streaming response；
- 服务升级后 Refresh Connector metadata。

### 提示 repository ambiguous

当前启用了多个仓库。显式传入目标 `repoId`，或者 disable 不应执行的仓库。

### Project 仍询问目标仓库

检查 Project instructions 是否写入准确 `repoId`，并明确要求每个 repo-harness 调用都传入它。写操作前继续校验目标是合理的安全行为。

### Quick tunnel 地址变化

更新 ChatGPT Connector URL，或迁移到 Cloudflare named tunnel、ngrok reserved domain、其他稳定 HTTPS 代理。

### 工具列表看起来是旧版

调用 `controller_capabilities`。如果 tool surface version 或 fingerprint 与 Connector snapshot 不一致，Refresh metadata 或重建 Connector。

## 14. 上游与许可证

本发行版基于 [AncientTwo/repo-harness](https://github.com/AncientTwo/repo-harness)，并包含大量 Controller Runtime 修改。归属与 MIT 条款见 [`NOTICE`](../NOTICE) 和 [`LICENSE`](../LICENSE)。
