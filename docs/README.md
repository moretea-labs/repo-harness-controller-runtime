# repo-harness Documentation

This is the public documentation hub for the current open-source/runtime surface. Product behavior is defined by executable code and [`docs/architecture/current/`](architecture/current/), not by historical design notes.

## Start here

- New user, English: [Public usage guide](public-usage-guide.md), then [Tutorials](tutorials/README.md)
- 新用户，中文: [公开使用指南](public-usage-guide.zh-CN.md)，再看 [教程目录](tutorials/README.zh-CN.md)
- Install and host MCP: [Tutorial 1](tutorials/01-install-and-start.md), [Tutorial 2](tutorials/02-connect-chatgpt.md)
- Run the first repository task: [Tutorial 3](tutorials/03-first-repository-task.md)
- Platform and setup boundaries: [Platform support](operations/platform-support.md), [Features and setup levels](operations/features.md)
- Fix install or connector problems: [Troubleshooting](operations/troubleshooting.md)

The default `core` surface is `rh_status`, `rh_inbox`, `rh_context`, and `rh_work`, plus `repository_list`, `repository_get`, `repository_register`, `repository_latest_source_diagnose`, and `repository_bootstrap_local_project`. Use `advanced` for operator diagnostics and `full` only for compatibility.

## Capability map

| Goal | Read this | Notes |
| --- | --- | --- |
| Understand the core ChatGPT facade | [Public usage guide](public-usage-guide.md) | Explains `rh_status`, `rh_inbox`, `rh_context`, `rh_work`, and the safe default path. |
| Connect ChatGPT to the local controller | [repo-harness ChatGPT MCP setup](repo-harness-chatgpt-mcp-setup.md) | Advanced/manual setup, tunnel choices, Connector auth, and toolset verification. |
| Learn the tool surface split | [MCP tool exposure](operations/mcp-tool-exposure.md) | `core` is the onboarding default; `advanced` and `full` are operator/compatibility surfaces. |
| Use the local Controller UI safely | [repo-harness ChatGPT MCP setup](repo-harness-chatgpt-mcp-setup.md) | The Local Controller UI stays on `127.0.0.1:8766`; it is not the public MCP endpoint. |
| Understand multi-repository routing | [README.en.md](../README.en.md), [README.md](../README.md) | The controller is global, but work is still scoped by stable `repoId` and `checkoutId`. |
| Configure providers and executor routing | [Provider configuration and routing](operations/provider-configuration.md) | Controller-scoped provider settings live under Controller Home, not in the repository. |
| Run supervised automation or schedules | [ChatGPT-Supervised Automation](repo-harness-chatgpt-supervised-automation.md), [Autonomous Goal Loop](repo-harness-autonomous-goal-loop.md) | Use after the manual/core path is healthy. |
| Use browser tasks | [Controller Browser Plugin](operations/controller-browser-plugin.md), [ChatGPT Browser Engine](repo-harness-chatgpt-browser-engine.md) | Covers local browser execution, screenshots, and ChatGPT-web planning/review flows. |
| Configure Google/Gmail/Calendar/Tasks | [Google Assistant Plugins](personal-assistant-google-plugins.md) | Workspace plugins are optional and remain separately authorized. |
| Use iOS simulator or App Store Connect tooling | [iOS Simulator Development Assistant](repo-harness-ios-development-assistant.md), [App Store Connect API Plugin](repo-harness-app-store-connect-api.md) | Simulator and Apple API flows are separate from generic repository work. |
| Recover runtime-storage or controller-state issues | [Self-healing loop](repo-harness-runtime-self-healing-loop.md), [Controller reliability runbook](operations/controller-reliability-runbook.md) | Use these when runtime metadata or durable jobs are unhealthy. |
| Diagnose 502s, stale connectors, or UI slowness | [Troubleshooting](operations/troubleshooting.md), [Controller performance and 502 troubleshooting](operations/controller-performance-and-502.md) | Check durable Job/Run state before replaying a write. |
| Prepare a public release | [Open-source release hygiene](operations/open-source-release-hygiene.md) | Validate package identity, public surface, credentials, paths, and release evidence. |

## Current runtime facts

- Controller Home is primary for MCP service config, authentication, provider settings, and runtime state: `mcp.local.json`, `mcp.tokens.json`, `mcp.oauth.json`, `mcp.oauth-tokens.json`, and `mcp.runtime.json` live under `controllerHome/mcp/`.
- The matching repo-local `.repo-harness/mcp.local.json`, `.repo-harness/mcp.tokens.json`, `.repo-harness/mcp.oauth.json`, `.repo-harness/mcp.oauth-tokens.json`, and `.repo-harness/mcp.runtime.json` files are legacy fallback only. Repository-scoped `.repo-harness/mcp.policy.json` remains the repository access policy.
- The controller is a global multi-repository service. Repository work still routes through explicit `repoId` and, when relevant, `checkoutId`.
- The public MCP endpoint is separate from the localhost-only Local Controller UI at `127.0.0.1:8766`. The UI is an execution-assistant console organized around Command Center, Approvals and Decisions, Current Work, Capabilities / Plugins, Models / Tools, System Status, Repositories, and Advanced Diagnostics.
- Long-running or verbose work is intentionally bounded in MCP responses. Expect durable Job/Run summaries and bounded artifact previews instead of raw unbounded logs by default.

## Reference sets

- Tutorials: [`tutorials/`](tutorials/)
- User/operator guides: [`operations/`](operations/)
- Runtime authority: [`architecture/current/README.md`](architecture/current/README.md)
- Historical records: [`architecture/history/`](architecture/history/), [`architecture/snapshots/`](architecture/snapshots/), [`researches/`](researches/)

Historical documents remain published for audit and migration context. They should not be treated as the current runtime contract.
