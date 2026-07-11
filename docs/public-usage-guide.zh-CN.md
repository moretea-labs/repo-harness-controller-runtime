# 公开使用指南

如果你只想用最短路径理解并开始使用 repo-harness，先看这一页。

## 最短路径

1. [安装并启动](tutorials/01-install-and-start.zh-CN.md)
2. [连接 ChatGPT](tutorials/02-connect-chatgpt.zh-CN.md)
3. [完成第一个仓库任务](tutorials/03-first-repository-task.zh-CN.md)

## repo-harness 是什么

repo-harness 是一个本地执行桥，让 ChatGPT 通过有边界的工具面处理一个或多个仓库。默认 ChatGPT 使用路径刻意保持很小：

- `rh_status` 检查运行时和仓库就绪状态
- `rh_context` 读取有界仓库上下文
- `rh_work` 发起或继续有边界的工作
- `rh_inbox` 处理决策、授权和待关注事项
- `repository_list`、`repository_get`、`repository_register`、`repository_latest_source_diagnose`、`repository_bootstrap_local_project` 用于选择、诊断或初始化仓库目标

小而确定的修改默认走 Direct Edit。需要跨会话恢复、带依赖拆分或保留审查证据的工作，才进入 durable 的 Issue → Task → Run 路径。本地 Agent、GitHub 会话、浏览器、调度和插件都属于可选增强层。

## 当前运行时事实

- Controller Home 是 MCP service 配置、认证和运行态的主存储位置；`controllerHome/mcp/` 下保存 `mcp.local.json`、`mcp.tokens.json`、`mcp.oauth.json`、`mcp.oauth-tokens.json` 和 `mcp.runtime.json`。
- 对应的 repo-local `.repo-harness/mcp.local.json`、`.repo-harness/mcp.tokens.json`、`.repo-harness/mcp.oauth.json`、`.repo-harness/mcp.oauth-tokens.json`、`.repo-harness/mcp.runtime.json` 只用于 legacy fallback；仓库级 `.repo-harness/mcp.policy.json` 仍是访问策略文件。
- Controller 是跨已注册仓库的全局服务，但仓库工作仍通过显式 `repoId` 和 `checkoutId` 路由。
- 公网 MCP endpoint 与 `127.0.0.1:8766` 上仅限本机访问的 Local Controller UI 是不同入口。当前 UI 是执行助手控制台，包含指挥中心、审批与决定、当前任务、能力 / 插件、模型与工具、系统状态、仓库和高级诊断。
- 长任务默认返回 durable Job / Run 的摘要和有界预览；看到 `502`、重连或大结果截断时，先确认 Job / Run 状态，不要直接假定写入失败。

## 按目标继续阅读

- 需要安装和 Connector 细节：看 [教程目录](tutorials/README.zh-CN.md)
- 需要 MCP / 隧道 / OAuth 手动配置：看 [repo-harness ChatGPT MCP 配置](repo-harness-chatgpt-mcp-setup.md)
- 需要 provider 或 executor 路由：看 [Provider 配置与路由](operations/provider-configuration.md)
- 需要浏览器、Gmail/Calendar 或其他插件：看持续维护的 [文档中心](README.md)
- 需要故障排查或 runtime-storage 恢复：看 [故障排查](operations/troubleshooting.zh-CN.md) 和 [自修复闭环](repo-harness-runtime-self-healing-loop.md)

更完整的导航请回到持续维护的[文档中心](README.md)。
