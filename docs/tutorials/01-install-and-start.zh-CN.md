# 教程 1：安装并启动

本教程完成 CLI 安装、用户级运行时初始化、环境检查和第一个仓库注册。

## 1. 选择平台路径

- macOS / Linux：完整支持。
- Windows：完整工作流推荐 WSL2。
- Windows 原生 PowerShell：预览支持安装、doctor、仓库注册/读取和可移植 Controller 操作。详细范围见[平台支持说明](../operations/platform-support.zh-CN.md)。

## 2. 安装基础环境

所有平台都需要：

- Git；
- Node.js 20.10 或更高版本；
- npm 或 Bun 1.0+；
- 可写的用户主目录。

Bun 是源码开发和完整测试的推荐执行器。Codex、Claude、`gh`、Tailscale、Cloudflare 和浏览器依赖均为可选，只在对应功能需要时安装。

```bash
git --version
node --version
npm --version
```

## 3. 安装 CLI

从 package registry 安装，可二选一：

```bash
npm install -g @moretea-labs/repo-harness-controller@next
# 或
bun add -g @moretea-labs/repo-harness-controller@next
```

Registry 包名是 `@moretea-labs/repo-harness-controller`，安装后提供 `repo-harness` 和 `repo-harness-hook` 两个命令；RC 阶段使用 `next` dist-tag。

macOS、Linux 或 WSL2 从源码安装：

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
REPO_HARNESS_DRY_RUN=1 ./install.sh
./install.sh
```

Windows 原生 PowerShell 从源码安装：

```powershell
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
Set-Location repo-harness-controller-runtime
.\install.ps1 -DryRun -Runtime auto
.\install.ps1 -Runtime auto
```

设置 `REPO_HARNESS_INSTALL_RUNTIME=node` 可强制使用 npm，设置为 `bun` 可强制使用 Bun。

## 4. 初始化用户级运行时

```bash
repo-harness install --no-cli
repo-harness doctor
```

`install --no-cli` 负责配置用户级 repo-harness 环境，不重复安装 package。Windows 原生会跳过 Bash skill 同步和 CodeGraph 自动配置；需要这些能力时使用 WSL2。

## 5. 接入或注册仓库

macOS、Linux、WSL2 先预览再执行完整接入：

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
```

Windows 原生先从注册和读取开始，依赖 shell 的接入流程放到 WSL2：

```powershell
repo-harness repo register C:\path\to\your-project --name my-project --json
repo-harness repo list --json
```

所有平台均可显式注册：

```bash
repo-harness repo register /path/to/your-project --name my-project --json
repo-harness repo list --json
```

保存返回的 `repoId`，它是 ChatGPT 和 Controller 使用的稳定仓库身份。

## 6. 确认环境就绪

```bash
repo-harness --version
repo-harness doctor
repo-harness repo list --json
```

运行态应保存在 Controller Home 和被忽略的仓库链接中，不应进入公开源码。不要提交 token、MCP runtime 文件、Local Job、日志或 worktree。

下一步阅读[教程 2：连接 ChatGPT](02-connect-chatgpt.zh-CN.md)。开启可选集成前先看[功能与配置层级](../operations/features.zh-CN.md)，出现问题时看[故障排查](../operations/troubleshooting.zh-CN.md)。
