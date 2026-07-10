# Installation and Connection Troubleshooting

## `repo-harness` is not found after installation

Reopen the terminal first. With npm, inspect the global prefix with `npm config get prefix`; its executable directory must be on `PATH`. With Bun, ensure the Bun bin directory is on `PATH`.

Verify the runtimes:

```bash
node --version
npm --version
bun --version   # optional
repo-harness --version
```

## Doctor reports missing Git or Node

Install Git and Node.js 20.10 or newer, then open a new terminal. Node is required even when the package was installed with Bun because the published launcher uses Node.

## Native Windows stops at a shell-owned step

Use WSL2 for repository adoption, Bash hooks, source release checks, or shell lifecycle scripts. Native Windows intentionally skips the Bash skill-sync and automatic CodeGraph steps.

## MCP works locally but ChatGPT cannot connect

`http://127.0.0.1:8765/mcp` is local-only. ChatGPT needs a stable public HTTPS URL ending in `/mcp`. Check the tunnel, the exact path, and `repo-harness mcp doctor`. Do not expose the local Controller UI port publicly.

## Only some tools appear in ChatGPT

The default surface is intentionally small. A healthy core connector should show `rh_status`, `rh_inbox`, `rh_context`, and `rh_work`, plus repository bootstrap/selection tools. Reconnect only after confirming the local MCP runtime is using the expected toolset.

## Agent delegation is unavailable

Core Direct Edit and repository workflows still work. Install and authenticate Codex or Claude, then restart MCP with the dev runner explicitly enabled. Do not enable agent flags in the basic setup unless the CLI is present.

## Repository paths behave differently between Windows and WSL2

Do not share one active checkout between native Windows and WSL2. Clone inside the environment that runs repo-harness and register that path. This avoids file-mode, line-ending, symlink, and performance problems.

## Release checks fail on personal paths or logs

Remove tracked runtime state, absolute home paths, credentials, logs, PID files, and generated artifacts. Do not add broad allowlist entries to silence genuine findings.
