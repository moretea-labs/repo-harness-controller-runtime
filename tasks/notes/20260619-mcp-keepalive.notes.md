# MCP Keepalive Notes

## Scope

- Fix recurring local `repo-harness` ChatGPT MCP disconnects without widening tool policy scope.

## Decisions

- Treat quick-tunnel URL churn as a first-class failure mode. The runtime now records when the public `/mcp` endpoint changes so operators can reconnect ChatGPT instead of debugging the wrong layer.
- Keep the tracked ChatGPT setup guide placeholder-only. Real public endpoints stay in ignored local config and runtime state so example domains do not leak into committed docs.
- Write runtime health into `.repo-harness/mcp.runtime.json` and ignore it in git. This gives `mcp doctor` enough state to distinguish local server failure, tunnel failure, and connector drift.
- Prefer a single `mcp keepalive` entrypoint to supervise both the local HTTP MCP server and optional `cloudflared` tunnel. This removes the previous split-process setup where either side could die silently.

## Follow-up

- Named tunnels remain the recommended long-lived ChatGPT path because quick tunnels still receive new public URLs after a full tunnel restart.
