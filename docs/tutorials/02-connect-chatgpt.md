# Tutorial 2: Connect ChatGPT

This tutorial starts the local MCP service, publishes only its MCP endpoint through HTTPS, and verifies the default facade tools.

## 1. Before you start

You need:

- a repository already registered with `repo-harness repo register`;
- a healthy `repo-harness doctor` result;
- a stable public HTTPS address ending in `/mcp`;
- ChatGPT access to Developer Mode and custom MCP connectors.

Coding agents are not required. Install Codex or Claude only when you intend to delegate implementation.

Windows users should run the Controller and tunnel inside WSL2 for the full supported workflow. Native PowerShell operation remains preview scope.

## 2. Generate the MCP configuration

```bash
repo-harness mcp setup chatgpt --repo /path/to/your-project
```

The local endpoint is loopback-only:

```text
http://127.0.0.1:8765/mcp
```

Do not expose the local Controller UI at port 8766.

## 3. Start the core toolset

Start without coding agents first:

```bash
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --tunnel tailscale \
  --public-endpoint https://mcp.example.com/mcp
```

Cloudflare named tunnels are also suitable. Temporary tunnel URLs are useful for testing but are poor long-lived Connector identities.

Enable delegated agents only after their CLIs are installed and authenticated:

```bash
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --enable-dev-runner \
  --dev-runner-agents codex,claude \
  --tunnel tailscale \
  --public-endpoint https://mcp.example.com/mcp
```

## 4. Add the Connector in ChatGPT

1. Open **Settings → Apps & Connectors → Advanced settings**.
2. Enable Developer Mode.
3. Create a custom MCP Connector.
4. Enter the public HTTPS URL ending in `/mcp`.
5. Add the Connector to a new conversation.

## 5. Verify the safe default surface

The core Connector should expose:

- `rh_status` — runtime and repository readiness;
- `rh_context` — bounded context for the selected repository;
- `rh_work` — start or continue bounded work;
- `rh_inbox` — decisions, approvals, and items requiring attention.

It also exposes a few repository bootstrap and selection tools. Do not switch to `full` merely to see more names; `advanced` and `full` are maintainer and compatibility surfaces.

Test in this order:

```text
Use repo-harness. Check system readiness with rh_status. Then load bounded context for my registered repository with rh_context. Do not make changes yet.
```

## 6. Security checks

- Keep MCP bound to loopback and publish it only through a controlled HTTPS endpoint.
- Keep the local UI private.
- Start read-only, then authorize bounded writes when needed.
- Remote Git, GitHub, email, destructive cleanup, and publication remain separately authorized.
- Never paste MCP tokens or OAuth secrets into chat.

Continue with [Tutorial 3: First Repository Task](03-first-repository-task.md). Use [Troubleshooting](../operations/troubleshooting.md) if the Connector or tool surface is not healthy.
