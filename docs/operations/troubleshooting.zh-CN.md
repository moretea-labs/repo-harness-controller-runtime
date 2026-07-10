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

## ChatGPT 只显示少量工具

这是默认设计。健康的 core connector 应看到 `rh_status`、`rh_inbox`、`rh_context`、`rh_work`，以及少量仓库初始化/选择工具。先确认本地 MCP toolset，再决定是否重连。

## 无法委派 Agent

核心 Direct Edit 和仓库工作流仍可使用。安装并登录 Codex 或 Claude 后，再显式开启 dev runner。基础配置不应默认加入 Agent 参数。

## Windows 与 WSL2 路径行为不一致

不要让一个 checkout 同时由 Windows 和 WSL2 操作。在哪个环境运行 repo-harness，就在该环境内 clone 并注册仓库，避免文件 mode、换行、symlink 和性能问题。

## 发布检查发现个人路径或日志

应删除被跟踪的运行态、绝对用户目录、凭据、日志、PID 和生成物，不要用大范围 allowlist 掩盖真实问题。
