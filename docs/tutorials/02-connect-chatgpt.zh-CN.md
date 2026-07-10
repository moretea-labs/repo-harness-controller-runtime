# 教程 2：连接 ChatGPT

## 准备 MCP 服务

```bash
repo-harness mcp setup chatgpt --repo /path/to/your-project
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --enable-dev-runner \
  --dev-runner-agents codex,claude \
  --tunnel tailscale
```

使用以 `/mcp` 结尾、受控的公网 HTTPS 地址。本地 MCP 仍应监听 loopback，不要把 Local Controller UI 暴露到公网。

## 添加 Connector

在 ChatGPT 中开启 Developer Mode，创建自定义 MCP Connector，填入 HTTPS `/mcp` 地址，并在新对话中启用它。

## 验证连接

1. 调用 `rh_status`，确认控制器已就绪。
2. 对已注册仓库调用 `rh_context`。
3. 确认默认工具面包含 `rh_status`、`rh_inbox`、`rh_context` 和 `rh_work`。

不要因为旧文档提到低层工具就切换到 `full`。只有运维诊断时才使用 `advanced`。

下一步：[完成第一个仓库任务](03-first-repository-task.zh-CN.md)。
