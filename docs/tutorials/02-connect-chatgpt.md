# Tutorial 2 — Connect ChatGPT

## Prepare the MCP service

```bash
repo-harness mcp setup chatgpt --repo /path/to/your-project
repo-harness mcp keepalive --repo /path/to/your-project \
  --profile controller \
  --toolset core \
  --enable-dev-runner \
  --dev-runner-agents codex,claude \
  --tunnel tailscale
```

Use a controlled public HTTPS URL ending in `/mcp`. Keep the local MCP server bound to loopback and never expose the Local Controller UI publicly.

## Add the Connector

In ChatGPT, enable Developer Mode, create a custom MCP Connector, and enter the HTTPS `/mcp` URL. Add that connector to a new chat.

## Verify the connection

1. Call `rh_status` and confirm the controller is ready.
2. Call `rh_context` for the registered repository.
3. Confirm the default surface contains `rh_status`, `rh_inbox`, `rh_context`, and `rh_work`.

Do not switch to `full` merely because older documentation mentions low-level tools. Use `advanced` only when an operator needs diagnostics.

Next: [Complete the first repository task](03-first-repository-task.md).
