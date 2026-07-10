# 平台支持说明

本文定义项目当前真正承诺的平台范围。代码中存在 Windows 分支并不等于所有流程都已在 Windows 原生环境验证；只有安装、主要工作流和发布检查均覆盖的范围才称为支持。

## 支持矩阵

| 平台 | 状态 | 建议用途 |
| --- | --- | --- |
| macOS | 支持 | 完整本地 Controller、仓库接入、MCP、Direct Edit、Agent、浏览器能力和发布检查。 |
| 现代 Linux | 支持 | 完整本地 Controller 工作流，需要 Bash、Git、Node.js 和常见进程工具。 |
| Windows + WSL2 | 支持，且是 Windows 推荐方案 | 在 WSL2 内按 Linux 流程运行，仓库建议放在 WSL 文件系统。 |
| Windows 原生 PowerShell | 预览支持 | 支持安装、CLI、doctor、仓库注册/读取和可移植运行时路径；依赖 Bash 的流程仍有限制。 |

## 基础环境

所有安装方式都需要：

- Git 已加入 `PATH`；
- Node.js 20.10 或更高版本，因为发布后的 `repo-harness` 启动器由 Node 执行；
- npm（随 Node.js 安装）或 Bun 1.0+，用于安装 package；
- 可写的用户主目录。

Bun 是开发和完整测试的推荐执行器，但不再是唯一安装器。

以下环境按功能选装：

- Codex 或 Claude CLI：委派复杂代码实现；
- GitHub CLI `gh`：GitHub Issue、Project 和云端 Agent；
- Tailscale Funnel 或 `cloudflared`：稳定公网 HTTPS `/mcp` 地址；
- Playwright 浏览器依赖：浏览器自动化；
- CodeGraph：额外代码导航；
- Google Workspace 凭据：Gmail、Calendar 插件。

## Windows 原生支持范围

Windows PowerShell 路径当前发布验证覆盖：

- 前置环境检查和 CLI 安装；
- `repo-harness --version`、命令加载与 `doctor`；
- 仓库注册表；
- 可移植测试覆盖的 Windows 路径、进程、junction 和命令处理；
- 不依赖 Bash helper 的默认 MCP facade 与有边界仓库操作。

暂不宣称完整原生支持：

- Bash 编写的仓库迁移和 Hook 脚本；
- `scripts/controller-runtime.sh` 生命周期；
- 完整源码发布 Bash 门禁；
- CodeGraph 自动配置；
- 所有 Agent CLI 与隧道组合。

这些场景请使用 WSL2。原生安装流程会主动跳过 Bash skill 同步和未验证的 CodeGraph 自动配置，而不是让整体安装失败。

## WSL2 使用建议

在 WSL2 内安装 Git、Node.js 和可选的 Bun，并将仓库放在 Linux 主目录，例如 `~/src/project`。不要让同一个 checkout 交替由 Windows 和 WSL 操作，否则文件权限、符号链接、换行符和运行时路径可能漂移。

ChatGPT 客户端和浏览器仍可运行在 Windows 主机；Controller 与 MCP 运行在 WSL2，只通过受控 HTTPS 隧道公开 MCP endpoint。

## 验证边界

仓库提供 `windows-latest` smoke workflow，验证 PowerShell dry-run、安装契约、Windows 默认策略和 Node 可移植测试。它证明的是上述有边界范围，不代表所有 Bash 或外部 Provider 集成都已原生 Windows 验证。
