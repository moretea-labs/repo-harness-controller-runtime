# 安装与连接故障排查

## 安装后找不到 `repo-harness`

先重新打开终端。npm 用户可执行 `npm config get prefix`，确认其可执行目录已加入 `PATH`；Bun 用户确认 Bun bin 目录已加入 `PATH`。

```bash
node --version
npm --version
bun --version   # 可选
repo-harness --version
```

## Doctor 提示缺少 Git 或 Node

安装 Git 和 Node.js 20.10+ 后重新打开终端。即使 package 由 Bun 安装，发布后的启动器仍由 Node 执行，因此 Node 是基础依赖。

## Windows 原生流程停在 shell 步骤

仓库接入、Bash Hook、源码发布检查或 shell 生命周期脚本请使用 WSL2。Windows 原生会主动跳过 Bash skill 同步和 CodeGraph 自动配置。

## 本机 MCP 正常，但 ChatGPT 无法连接

`http://127.0.0.1:8765/mcp` 只能本机访问。ChatGPT 需要稳定的公网 HTTPS `/mcp` 地址。检查隧道、路径和 `repo-harness mcp doctor`。不要把本地 Controller UI 端口暴露到公网。

## MCP 配置看起来写到了错误的位置

当前 service-level MCP 配置以 Controller Home 为主，不再以仓库内文件作为新安装主路径：

- `controllerHome/mcp/mcp.local.json`
- `controllerHome/mcp/mcp.tokens.json`
- `controllerHome/mcp/mcp.oauth.json`
- `controllerHome/mcp/mcp.oauth-tokens.json`
- `controllerHome/mcp/mcp.runtime.json`

仓库内的 `.repo-harness/mcp.local.json`、`.repo-harness/mcp.tokens.json`、`.repo-harness/mcp.oauth.json`、`.repo-harness/mcp.oauth-tokens.json`、`.repo-harness/mcp.runtime.json` 只作为 legacy compatibility fallback；仓库级 `.repo-harness/mcp.policy.json` 仍是访问策略文件。如果你发现两边配置混在一起，先重新执行 `repo-harness mcp setup chatgpt --repo /path/to/your-project`，然后重启 MCP 服务，并优先从 Controller Home 核对当前 endpoint 和 server name。

## ChatGPT 只显示少量工具

默认 Controller 使用固定、可修复的工具 schema（通常 100–128 个工具）。Request/Full Access 不会改变 schema。请从 `rh_status` 或 `controller_ready` 对比 `expectedToolCount`、`actualToolCount`、缺失/意外工具和 fingerprint；只有 Connector 快照本身过期时才需要重连，权限切换不需要。

## runtime storage 未就绪，或本地 UI 看起来是旧状态

不要把删除 `.ai/harness`、`.repo-harness` 或 Controller Home 状态当成第一反应。先做有界诊断：

```bash
repo-harness mcp doctor --repo /path/to/your-project
repo-harness repo list --json
```

如果你正在使用运维/高级工具面，先走 runtime maintenance 路径，再决定是否重启或重放写操作。安全恢复流程见：

- `runtime_maintenance_status`
- `runtime_maintenance_apply`
- [自修复闭环](../repo-harness-runtime-self-healing-loop.md)
- [Controller 可靠性 runbook](controller-reliability-runbook.md)

看到 `502`、重连或大结果截断，不代表 durable 写入一定失败；先回到 Job、Run 或证据摘要确认真实状态。

## 无法委派 Agent

核心 Direct Edit 和仓库工作流仍可使用。安装并登录 Codex 或 Claude 后，再显式开启 dev runner。基础配置不应默认加入 Agent 参数。

## Windows 与 WSL2 路径行为不一致

不要让一个 checkout 同时由 Windows 和 WSL2 操作。在哪个环境运行 repo-harness，就在该环境内 clone 并注册仓库，避免文件 mode、换行、symlink 和性能问题。

## 发布检查发现个人路径或日志

应删除被跟踪的运行态、绝对用户目录、凭据、日志、PID 和生成物，不要用大范围 allowlist 掩盖真实问题。
