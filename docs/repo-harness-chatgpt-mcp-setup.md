# repo-harness ChatGPT Controller Setup

> Advanced manual setup reference. New users should follow [Tutorial 1](tutorials/01-install-and-start.md), [Tutorial 2](tutorials/02-connect-chatgpt.md), and [Tutorial 3](tutorials/03-first-repository-task.md) first.

## Purpose

The `controller` profile makes ChatGPT the project control plane. ChatGPT can inspect code and documents, maintain durable Issues and dependency-aware Tasks, apply bounded direct edits, publish Issues to GitHub Projects, dispatch short local Codex/Claude runs or visible GitHub Copilot cloud sessions, and review the resulting state. Repository files remain the source of truth; chat history is not required for recovery.

## Prerequisites

- A repo-harness adopted repository.
- Bun and the `repo-harness` CLI on PATH.
- Codex and/or Claude CLI installed for delegated local execution.
- GitHub CLI `gh` authenticated when GitHub Issues, Projects, or Copilot cloud sessions are used.
- ChatGPT workspace access to Developer Mode and custom MCP Connectors.
- A public HTTPS `/mcp` endpoint for ChatGPT.

For a shared editable installation, keep the repo-harness checkout at a stable path such as `~/DevProjects/repo-harness`, run `bun install`, and reinstall the CLI after pulling updates.

## One-time setup

```bash
repo-harness mcp setup chatgpt --repo .
repo-harness mcp keepalive --repo . --profile controller --toolset core --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
```

The `controller` profile starts a localhost-only execution-assistant console at `http://127.0.0.1:8766/` by default. It is separate from the public MCP tunnel and is organized around Command Center, Approvals and Decisions, Current Work, Capabilities / Plugins, Models / Tools, System Status, Repositories, and Advanced Diagnostics. Add `--open-local-ui` to open it automatically, or `--no-local-ui` to disable it.

Health check:

```bash
curl http://127.0.0.1:8765/health
repo-harness mcp doctor --repo .
```

For a fixed Cloudflare domain, verify both local and public discovery without leaking tokens:

```bash
curl http://127.0.0.1:8765/health
curl https://<named-tunnel-host>/.well-known/oauth-protected-resource/mcp
env | grep -Ei 'proxy|no_proxy'
HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= curl -v https://<named-tunnel-host>/mcp
```

If a local HTTP proxy interferes with endpoint checks, add the fixed domain, `*.trycloudflare.com`, `*.ts.net`, and `100.64.0.0/10` to `NO_PROXY` instead of disabling proxies globally.

The controller profile stores service-level MCP state under `controllerHome/mcp/`: `mcp.local.json` for configuration, `mcp.tokens.json` for bearer auth, `mcp.oauth.json` for the OAuth passphrase, `mcp.oauth-tokens.json` for OAuth token state, and `mcp.runtime.json` for runtime status. The matching repo-local `.repo-harness/mcp.*` service files remain legacy fallback only.

Repository-specific MCP access rules may be added in `.repo-harness/mcp.policy.json`. Repository policy can narrow access, but immutable secret, credential, Git-internal, and build-output denies remain enforced.

## Stable endpoint

Use this Connector URL:

```text
<https-tunnel-url>/mcp
```

Quick tunnels are useful for one-off smoke tests, but their URL may change. For routine use, prefer a fixed Cloudflare domain. If repo-harness should start the Cloudflare tunnel process, use a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create repo-harness-mcp
cloudflared tunnel route dns repo-harness-mcp <named-tunnel-host>
repo-harness mcp keepalive --repo . --profile controller --toolset core --enable-dev-runner --dev-runner-agents codex,claude --tunnel named --cloudflare-tunnel-name repo-harness-mcp --public-endpoint https://<named-tunnel-host>/mcp
```

If Cloudflare is managed outside repo-harness, keep repo-harness on the fixed public origin without owning the tunnel process:

```bash
repo-harness mcp setup chatgpt --repo . --endpoint https://<named-tunnel-host>/mcp
repo-harness mcp keepalive --repo . --profile controller --toolset core --enable-dev-runner --dev-runner-agents codex,claude --tunnel none --public-endpoint https://<named-tunnel-host>/mcp
```

Regenerate this guide with the stable endpoint:

```bash
repo-harness mcp setup chatgpt --repo . --endpoint <https-url>/mcp
```

The real endpoint stays in ignored local config; the tracked guide stays placeholder-only. The OAuth discovery endpoint includes `oauth-protected-resource` metadata.

## Create the ChatGPT Connector

1. Open ChatGPT Settings and enable Developer Mode.
2. Create a custom Connector using the server name from `controllerHome/mcp/mcp.local.json` under `chatgpt.serverName`.
3. Paste the public HTTPS URL ending in `/mcp`.
4. Configure Connector authentication as OAuth. ChatGPT must use the `/mcp` OAuth URL; do not point ChatGPT at `/mcp-bearer`.
5. Scan tools and authorize with the passphrase from `controllerHome/mcp/mcp.oauth.json`.
6. Keep write confirmations enabled.
7. Re-scan tools after updating repo-harness tool schemas.

### Non-OAuth MCP clients (Grok and similar)

Clients that cannot complete OAuth dynamic client registration + PKCE should use the dedicated bearer endpoint instead of `/mcp` or `/authorize`:

```text
<https-tunnel-url>/mcp-bearer
```

Authenticate with `Authorization: Bearer <token>` using the token stored under `controllerHome/mcp/mcp.tokens.json` (or `REPO_HARNESS_MCP_TOKEN`). Do not paste the raw token into chat or docs. `/health` advertises both `mcpEndpoint` and `bearerEndpoint`. Incomplete OAuth hits on `/authorize` return HTTP 400 and point clients to `/mcp-bearer`.

## Verify the loaded tool surface

Default `--toolset core` exposes `rh_status`, `rh_inbox`, `rh_context`, `rh_work`, plus `repository_list`, `repository_get`, `repository_register`, `repository_latest_source_diagnose`, and `repository_bootstrap_local_project`. Use `--toolset advanced` for operator diagnostics or `--toolset full` for legacy compatibility. After connecting, call `rh_status`; `controller_capabilities` is available only on `advanced` or `full`. If only legacy planning tools are visible, refresh or recreate the Connector so ChatGPT reloads the MCP tool schema.

## Refresh newly added repository tools

For the current repository only, prefer a bounded local restart:

```bash
repo-harness mcp restart --repo .
```

If this repository is already registered with the global Controller and also needs a local harness refresh, use a repo-scoped rollout instead of an unscoped rollout:

```bash
repo-harness repo rollout --repo-id <current-repo-id>
```

A repo-scoped rollout refreshes the selected Registry record and repo-local harness files. Its compatibility restart step runs only when that repository still has a matching legacy `.repo-harness/mcp.local.json`; this does not make the repo-local file the service authority. Live MCP service config, auth, OAuth token state, and runtime state remain under Controller Home. After restart or rollout, rescan or recreate the ChatGPT Connector, call `rh_status`, and confirm the facade plus repository bootstrap tools are present. On `advanced` or `full`, you may additionally inspect `controller_capabilities`. Do not run an unscoped rollout unless you intentionally want to refresh every registered repository.

## Daily workflow

Start a new ChatGPT conversation with:

```text
Use repo-harness as the project controller. Start with rh_status and rh_context. Use rh_work for bounded repository work and rh_inbox when a decision or approval is required. Keep work in small dependency-aware units and delegate to an Agent only when needed.
```

Typical requests:

```text
Analyze this requirement and the current implementation. Create or update an Issue and split it into executable Tasks. Do not execute yet.
```

```text
Inspect readiness for this Issue, publish it to GitHub when collaboration is useful, and launch at most two independent Tasks. Review every local diff or GitHub pull request and record verification evidence before accepting it.
```

```text
Read the project board and failed Runs. Retry only the smallest failed Task, or re-plan the Issue when the original split is wrong.
```

```text
This is a small local fix. Open a bounded edit session, modify only the named files, inspect the Git diff, run focused checks, and finalize or rollback the edit.
```

## Persistent model

```text
Issue
  -> Task T1
       -> Run 1
       -> Run 2 (retry)
  -> Task T2
  -> Task T3
```

- Issues and Tasks are stored under `tasks/issues/` as JSON plus readable Markdown.
- Agent jobs, logs, edit backups, and worktrees are stored under ignored `.ai/harness/` runtime directories.
- A completed isolated agent Run moves its Task to review. ChatGPT must inspect it with `get_task_diff`, integrate it with `integrate_task_run`, record named-check and criterion evidence through `verify_task`, then explicitly accept it or request changes.
- Dependency completion unlocks later Tasks automatically.
- Any new ChatGPT conversation can recover state through `project_snapshot` and `get_project_board`.

## Capability boundaries

- `observe`: inspect repository state, search code, and read bounded file ranges.
- `manage`: create Issues, dynamically split Tasks, inspect launch readiness, publish to GitHub Issues/Projects, update status, and maintain project documents.
- `edit`: use a bounded edit session with allowed paths, SHA preconditions, change limits, backups, and rollback.
- `execute`: dispatch a ready Task to an allowed local agent in an isolated worktree or to a visible GitHub Copilot cloud session.
- Protected operations such as secrets, Git internals, package lockfiles, CI workflow changes, commits, merges, and pushes are not default controller actions.

The legacy planner/orchestrator handoff remains available for compatibility. When explicitly enabled, `run_agent_goal` reads only `.ai/harness/handoff/codex-goal.md`; new work should prefer `dispatch_task` and persistent Task Runs.

## Logged-in Browser Tasks

Use the local controller path when a website task depends on existing browser state, a visible browser window, or a localhost-only target.

- Prefer `dispatch_task` to a local `codex` or `claude` Run for browser-heavy work. The Task/Run record survives retries, pauses, and user-completed login or MFA steps.
- Treat `run_agent_goal` as compatibility-only. It reads a single handoff file and does not add durable Task/Run state around browser checkpoints.
- Do not send login-state-dependent browser work to `github-copilot` cloud sessions. Cloud sessions cannot see the local Chrome/Chromium profile, local cookies, or localhost-only pages.
- For controller browser-plugin work that must reuse an existing signed-in Chrome profile, configure the plugin explicitly with `profileMode=custom` plus `browserChannel=chrome` or `executablePath`. Repo-local default mode stays isolated and does not silently attach to the user's real browser profile.
- The browser plugin still closes after each bounded action. When a task needs manual login, captcha, MFA, or consent, let the user complete that step in the browser first, then continue the same local Task Run.

## Dev Mode Agent Runner

Local Agent execution is opt-in. GitHub cloud sessions use authenticated `gh` and do not require the local dev runner:

```bash
repo-harness mcp serve --repo . --transport http --host 127.0.0.1 --port 8765 --profile controller --enable-dev-runner --dev-runner-agents codex,claude
```

The runner defaults to 60 minutes per local Task and supports explicit values up to 12 hours. Requested values are validated and persisted unchanged; an invalid value fails instead of silently falling back to 120 seconds.

The runner:

- accepts only configured `codex` or `claude` agents;
- creates one persistent Run per Task;
- normally creates an isolated Git worktree;
- records prompt, process metadata, streaming stdout/stderr, structured events, and result under `.ai/harness/jobs/`;
- never exposes arbitrary shell input through MCP;
- does not commit, merge, or push automatically.

Watch local or GitHub execution from a terminal:

```bash
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
```

The `--log` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.

Use `repo-harness mcp keepalive` when the local server and tunnel should be supervised together.

## Local Codex MCP

Configure Codex to read repo-harness state:

```bash
repo-harness mcp setup codex --repo . --scope project
```

The executor profile remains read-oriented. Controller-dispatched Codex work is scoped by the generated Task prompt and worktree.

## Security

- Keep OAuth passphrases, bearer tokens, tunnel tokens, `~/.codex/auth.json`, and other credentials out of chat and Git.
- Keep the MCP server bound to loopback; expose it only through the authenticated tunnel.
- Do not remove immutable hard-deny patterns in order to make a Task pass.
- Review every completed local diff or GitHub pull request and record passing Verification Gate evidence before accepting a Task.
- Use the smallest allowed path set and focused checks for direct edits.

## Troubleshooting

- ChatGPT cannot connect: verify the HTTPS tunnel ends in `/mcp` and local `/health` responds.
- Grok or other non-OAuth clients loop on `/authorize`: use `…/mcp-bearer` with a bearer token from `controllerHome/mcp/mcp.tokens.json`; do not use OAuth `/mcp` for those clients.
- ChatGPT auth loops: retry authorization and inspect `controllerHome/mcp/mcp.oauth.json` first, then legacy `.repo-harness/mcp.oauth.json` only when using fallback; do not paste the passphrase into chat.
- Tool scan misses tools: run `repo-harness mcp restart --repo .`, then rescan or recreate the versioned Connector and call `rh_status`; confirm the facade and repository bootstrap tools are present. On `advanced` or `full`, you may additionally inspect `controller_capabilities`.
- Codex cannot see the MCP server: rerun `repo-harness mcp setup codex --repo . --scope project`.
- A quick tunnel URL changed: update the Connector URL or switch to a named tunnel.
- A Task is blocked: inspect `get_task_run`, shrink or re-plan the Task, then retry that Task rather than redispatching the full Issue.
