# 功能与配置层级

repo-harness 不依赖编码 Agent 或外部插件也能使用。先完成核心工作流，再按实际任务启用集成能力。

## 核心功能

默认本地配置包含：

- 用稳定 `repoId`、`checkoutId` 注册和选择仓库；
- 有边界的仓库读取与上下文聚合；
- 默认四个 ChatGPT facade：`rh_status`、`rh_inbox`、`rh_context`、`rh_work`；
- Direct Edit：路径限制、SHA 前置条件、多 revision、savepoint、diff、检查和回滚；
- 可恢复的 Issue → Task → Run 状态与执行证据；
- 命名检查，而不是向远端开放任意 shell；
- 本地 Controller UI 和追加式活动/证据记录；
- Controller Home 运行态隔离；
- 多仓库显式路由；
- 发布门禁、tracked-file 卫生检查和公共导出。

## 可选能力

| 集成 | 增加的能力 | 需要的环境 |
| --- | --- | --- |
| Codex / Claude | 处理超出 Direct Edit 范围的复杂实现 | 安装并登录对应 CLI，显式开启 dev runner。 |
| GitHub | Issue/Project 同步、PR、云端 Agent | 已认证的 `gh` 和仓库权限。 |
| Tailscale / Cloudflare | 为 ChatGPT MCP 提供稳定 HTTPS 地址 | 隧道客户端及对应账号/域名。 |
| Browser | Playwright 浏览、截图和证据 | 浏览器 binary 与允许访问的域名。 |
| CodeGraph | 代码关系和影响范围导航 | CodeGraph CLI；Windows 原生暂不自动配置。 |
| Google Workspace | Gmail、Calendar 助手能力 | 显式 OAuth 与插件权限。 |
| Schedule / Finding | 受监督的周期检查和候选发现 | Controller daemon 持续运行，真实动作仍受策略控制。 |

## 工具暴露

默认 `core` 只暴露四个 facade 和仓库初始化/选择工具。维护和诊断时才使用 `advanced`；`full` 只用于旧集成兼容，不是新用户教程路径。

## 如何选择执行方式

- 小而明确的修改优先 Direct Edit。
- 需要跨会话、存在依赖或需要正式证据时使用持久 Task。
- 只有调查或实现范围确实较大时才委派 Agent。
- 接受结果前运行命名检查并审查 diff。

## 授权边界

读取和本地有界检查可以自动执行；仓库写入、破坏性清理、外部副作用、远程 Git、GitHub 变更、邮件动作和发布仍需策略授权。连接 ChatGPT 不代表获得任意 shell 或任意文件系统权限。
