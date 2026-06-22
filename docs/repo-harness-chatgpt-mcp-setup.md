# repo-harness ChatGPT MCP Connector Setup

## Recommended mode

Use one long-running `controller` Connector. Do not switch between planner and orchestrator for routine work. The controller exposes repository inspection, Issue/Task management, bounded edits, named checks, local Agent Runs, and optional GitHub Issue/Project/Copilot-session integration.

Legacy `planner`, `executor`, and `orchestrator` profiles remain available for compatibility.


## Verify the loaded tool surface

After connecting ChatGPT, call `controller_capabilities`. It should report `controller-execution-first-v7` and list request assessment, direct edit sessions, persisted patch inspection, named-check verification, Issue/Task execution, and optional GitHub tools. If ChatGPT only shows legacy planning tools, refresh or recreate the connector so it reloads the MCP tool schema.


## Direct-change-first workflow

For a known small documentation, configuration, or code change, do not create an Issue first. Use:

```text
assess_work_request
-> read_repository_file
-> begin_edit_session
-> apply_patch
-> get_edit_session_diff
-> verify_edit_session
-> finalize_edit_session
```

Use `create_issue` and Agent Runs only when the work needs investigation, dependencies, broad scope, parallel execution, long-running checks, or elevated risk. The local Controller **File Changes** view shows direct-edit files, the persisted patch, checks, finalization, and rollback history.

## Prerequisites

- An adopted repository.
- A local repo-harness CLI installation.
- ChatGPT workspace access to custom MCP Connectors/Developer Mode.
- A public authenticated HTTPS endpoint ending in `/mcp`.
- Local Codex/Claude CLIs only when local Agent Runs are required.
- GitHub CLI `gh` only when GitHub Issues, Projects, or Copilot cloud sessions are required.

## Install from an editable checkout

```bash
git clone https://github.com/Ancienttwo/repo-harness.git ~/DevProjects/repo-harness
cd ~/DevProjects/repo-harness
bun install
bun src/cli/index.ts install --target codex --no-hooks --no-external-skills --no-codegraph
```

After updating the checkout, rerun the install command so the global CLI points at the new tool definitions.

## Configure the repository

```bash
repo-harness adopt --repo .
repo-harness mcp setup chatgpt --repo .
repo-harness mcp setup codex --repo . --scope project
```

Check GitHub integration when needed:

```bash
repo-harness controller github status --repo .
```

## Start the Controller

```bash
repo-harness mcp keepalive --repo . \
  --host 127.0.0.1 --port 8765 \
  --profile controller \
  --enable-dev-runner \
  --dev-runner-agents codex,claude \
  --tunnel quick
```

The `controller` profile starts a localhost-only V6 direct-change and execution-closure controller at `http://127.0.0.1:8766/` by default. It is separate from the public MCP tunnel. Use it to inspect actual file changes and persisted patches, verify/finalize/rollback direct edits, inspect project progress and Task history, launch complex work, review worklog evidence, approve local Jobs, inspect live logs, run named checks, and configure the optional GitHub plugin. Add `--open-local-ui` to open it automatically, or `--no-local-ui` to disable it.

`--enable-dev-runner` is required only for local Codex/Claude workers. GitHub Copilot cloud sessions use authenticated `gh` and do not require the local dev runner.

Local Agent Runs default to **60 minutes** and accept explicit limits from 5 seconds up to **12 hours**. `timeout_ms` is validated and persisted unchanged into Run metadata and `worker-config.json`; invalid values fail explicitly instead of falling back to 120 seconds. Override the service policy only when needed:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --dev-runner-timeout-ms 3600000 \
  --dev-runner-max-timeout-ms 43200000 \
  --tunnel quick
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

The OAuth passphrase is stored in the ignored local file:

```bash
jq -r .passphrase .repo-harness/mcp.oauth.json
```

Never commit or paste this passphrase into Issues, PRs, logs, or prompts.

## Stable tunnel

Quick tunnels are suitable for smoke testing, but their URL may change. For daily use, prefer a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create repo-harness-mcp
cloudflared tunnel route dns repo-harness-mcp <named-tunnel-host>
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel named \
  --cloudflare-tunnel-name repo-harness-mcp \
  --public-endpoint https://<named-tunnel-host>/mcp
```

## Create or refresh the ChatGPT Connector

1. Open ChatGPT Settings and enable Developer Mode when available.
2. Open Connectors and create the Connector using the HTTPS endpoint ending in `/mcp`.
3. Select OAuth authentication.
4. Enter the local passphrase on the authorization page.
5. Scan tools and keep write confirmations enabled.
6. After upgrading repo-harness or changing the profile, rescan tools. If the old tool snapshot remains, remove and recreate the Connector.

A successful controller scan should include tools such as:

```text
project_snapshot
search_repository
create_issue
inspect_issue_readiness
publish_issue_to_github
launch_issue
dispatch_task
get_task_run_events
verify_task
begin_edit_session
```

If only PRD/Sprint/Goal tools appear, ChatGPT is still using an old Planner tool snapshot.

## Daily workflow

```text
Understand request and implementation
  -> create/update local Issue
  -> inspect readiness
  -> optionally publish to GitHub Issues/Project
  -> launch narrow Tasks
  -> watch local Runs or GitHub cloud sessions
  -> review diff/PR
  -> run checks and record verification
  -> accept Task
  -> close Issue only after all work is verified
```

Local visibility:

```bash
repo-harness controller board --repo .
repo-harness controller runs --repo .
repo-harness controller watch <RUN-ID> --repo . --log
```

The `--log` view streams local Codex/Claude output while the process is running and polls GitHub cloud-session logs when available.

GitHub workflow details are documented in [GitHub Issue Launcher and Copilot Cloud Sessions](repo-harness-github-issue-launcher.md).

## Security boundaries

- MCP exposes no arbitrary shell-command tool.
- Immutable secret, credential, Git-internal, and sensitive runtime denies cannot be removed by repo-local policy.
- Local workers do not automatically commit, push, merge, or publish.
- GitHub publication and cloud-session launch are explicit open-world operations.
- A successful Agent Run cannot directly complete a Task; `verify_task` evidence is required.
- Local isolated Runs must be reviewed and integrated before acceptance.
- GitHub pull requests remain subject to repository review, checks, and merge protections.
