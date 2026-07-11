# Public Usage Guide

Use this page when you want the shortest current path through repo-harness without reading the entire docs tree first.

## Fast path

1. [Install and start](tutorials/01-install-and-start.md)
2. [Connect ChatGPT](tutorials/02-connect-chatgpt.md)
3. [Complete the first repository task](tutorials/03-first-repository-task.md)

## What repo-harness is

repo-harness is a local execution bridge that lets ChatGPT work on one or more repositories through a bounded tool surface. The default ChatGPT path is intentionally small:

- `rh_status` checks runtime and repository readiness
- `rh_context` loads bounded repository context
- `rh_work` starts or continues bounded work
- `rh_inbox` handles decisions, approvals, and attention items
- `repository_list`, `repository_get`, `repository_register`, `repository_latest_source_diagnose`, and `repository_bootstrap_local_project` select or bootstrap repository targets

Direct Edit is the default for small known changes. Durable Issue → Task → Run flows are for work that must survive sessions, carry dependencies, or preserve review evidence. Local coding agents, GitHub sessions, browser work, schedules, and plugins are optional layers.

## Current runtime facts

- Controller Home is primary for MCP service config, authentication, and runtime state under `controllerHome/mcp/`: `mcp.local.json`, `mcp.tokens.json`, `mcp.oauth.json`, `mcp.oauth-tokens.json`, and `mcp.runtime.json`.
- The matching repo-local `.repo-harness/mcp.local.json`, `.repo-harness/mcp.tokens.json`, `.repo-harness/mcp.oauth.json`, `.repo-harness/mcp.oauth-tokens.json`, and `.repo-harness/mcp.runtime.json` files are legacy fallback only. Repository-scoped `.repo-harness/mcp.policy.json` remains the access policy.
- The controller is global across registered repositories, but repository work still routes by explicit `repoId` and `checkoutId`.
- The public MCP endpoint is separate from the localhost-only Local Controller UI on `127.0.0.1:8766`. The UI is an execution-assistant console with Command Center, Approvals and Decisions, Current Work, Capabilities / Plugins, Models / Tools, System Status, Repositories, and Advanced Diagnostics.
- Long-running work returns durable Jobs/Runs with bounded previews. Check those records before assuming a `502`, reconnect, or truncated response means the write failed.

## Choose the next guide by goal

- Need install and connector setup: [Tutorials](tutorials/README.md)
- Need manual MCP/tunnel details: [repo-harness ChatGPT MCP setup](repo-harness-chatgpt-mcp-setup.md)
- Need provider or executor routing: [Provider configuration and routing](operations/provider-configuration.md)
- Need browser, Gmail/Calendar, or other plugins: [Documentation hub](README.md)
- Need troubleshooting or runtime-storage recovery: [Troubleshooting](operations/troubleshooting.md), [Self-healing loop](repo-harness-runtime-self-healing-loop.md)

For the broader map, use the maintained [documentation hub](README.md).
