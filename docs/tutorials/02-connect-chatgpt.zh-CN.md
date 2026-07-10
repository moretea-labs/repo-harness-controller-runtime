# 教程 2：连接 ChatGPT

本教程启动本地 MCP 服务，只通过 HTTPS 公开 MCP endpoint，并验证默认 facade 工具。

## 1. 开始前需要

- 已通过 `repo-harness repo register` 注册仓库；
- `repo-harness doctor` 状态正常；
- 一个稳定、以 `/mcp` 结尾的公网 HTTPS 地址；
- ChatGPT Developer Mode 和自定义 MCP Connector 权限。

编码 Agent 不是必需环境。只有准备委派实现时才安装 Codex 或 Claude。

Windows 用户建议在 WSL2 内运行 Controller 和隧道；Windows 原生 PowerShell 仍属于预览范围。

## 2. 生成 MCP 配置

```bash
repo-harness mcp setup chatgpt --repo /path/to/your-project
```

本地 endpoint 只监听 loopback：

```text
http://127.0.0.1:8765/mcp
```

不要把 8766 端口的本地 Controller UI 暴露到公网。

## 3. 先启动 core 工具集

基础配置不要默认开启 Agent：

```bash
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --tunnel tailscale \
  --public-endpoint https://mcp.example.com/mcp
```

Cloudflare named tunnel 也适合长期使用；临时 URL 只适合测试，不适合固定 Connector。

只有 Codex/Claude CLI 已安装并登录后，才开启委派能力：

```bash
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --enable-dev-runner \
  --dev-runner-agents codex,claude \
  --tunnel tailscale \
  --public-endpoint https://mcp.example.com/mcp
```

## 4. 在 ChatGPT 添加 Connector

1. 打开 **Settings → Apps & Connectors → Advanced settings**。
2. 开启 Developer Mode。
3. 创建自定义 MCP Connector。
4. 填入以 `/mcp` 结尾的公网 HTTPS URL。
5. 在新会话中添加该 Connector。

## 5. 验证默认安全工具面

core Connector 应显示：

- `rh_status`：运行时和仓库就绪状态；
- `rh_context`：当前仓库的有界上下文；
- `rh_work`：开始或继续有边界工作；
- `rh_inbox`：需要决定、审批或处理的事项。

此外只会暴露少量仓库初始化和选择工具。不要为了“工具更多”直接切到 `full`；`advanced` 和 `full` 是维护/兼容工具面。

按以下顺序测试：

```text
使用 repo-harness。先用 rh_status 检查系统状态，再用 rh_context 获取当前注册仓库的有界上下文，暂时不要修改文件。
```

## 6. 安全检查

- MCP 保持监听 loopback，只通过受控 HTTPS 地址公开。
- 本地 UI 不公开。
- 先只读，确有需要时再授权有边界写入。
- 远程 Git、GitHub、邮件、破坏性清理和发布仍分别授权。
- 不要把 MCP token 或 OAuth secret 粘贴到聊天中。

下一步阅读[教程 3：完成第一个仓库任务](03-first-repository-task.zh-CN.md)。Connector 或工具面异常时看[故障排查](../operations/troubleshooting.zh-CN.md)。
