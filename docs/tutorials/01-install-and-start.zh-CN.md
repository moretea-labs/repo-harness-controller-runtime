# 教程 1：安装并启动

## 环境要求

- Git
- Node.js 20.10 或更高版本
- Bun 1.0 或更高版本
- 主要本地控制器流程面向 macOS / Linux

## 从源码运行

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
bun run controller:start
bun run controller:status
```

健康状态应显示 Controller daemon、`127.0.0.1:8765` 的 MCP Gateway 和 `127.0.0.1:8766` 的 Local Controller 均已就绪。

## 注册目标仓库

```bash
bun run src/cli/index.ts repo register /path/to/your-project --name my-project --json
bun run src/cli/index.ts repo list --json
```

保存返回的 `repoId` 和 `checkoutId`。运行态与日志只保存在本机，不应提交到 Git。

下一步：[连接 ChatGPT](02-connect-chatgpt.zh-CN.md)。
