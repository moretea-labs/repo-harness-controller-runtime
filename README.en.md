# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime — ChatGPT controls repository work through a local, reviewable execution bridge" width="1280">
</p>

<p align="center">
  <strong>ChatGPT as the controller. Your repository as the source of truth.</strong>
</p>

<p align="center">
  <a href="README.en.md">English</a> · <a href="README.md">简体中文</a>
</p>

`repo-harness Controller Runtime` is a local-first repository execution bridge for ChatGPT. It gives ChatGPT bounded tools to inspect repositories, manage Issues and Tasks, apply Direct Edits, run named checks, review diffs, and optionally delegate implementation to coding agents.

The project is designed for real repositories rather than disposable chat sessions: plans, task state, execution evidence, checks, and handoffs remain attached to the repository and can be resumed later. The current runtime uses a Thin Gateway, durable Jobs, a Global Scheduler, one Repo Actor per repository, isolated Workers, and an Evidence Plane.

> Current package version: `1.4.0`
>
> Controller tool surface: `controller-chatgpt-bridge-v8`, schema `10`, surface version `8`

## Why this project

- **ChatGPT controls the workflow.** ChatGPT reads, reasons, selects an execution mode, reviews changes, and decides what to do next.
- **Direct Edit first.** Small, known changes use bounded edit sessions with SHA protection, persisted diffs, savepoints, checks, and rollback.
- **Agents are optional workers.** Codex, Claude, or GitHub Copilot can be delegated larger implementation work, but they are not required for every change.
- **Repository state survives conversations.** Issues, Tasks, Runs, verification evidence, and handoffs are file-backed.
- **Multiple repositories are explicit.** Each registered repository receives a stable `repoId`; ambiguous multi-repository operations must name the target repository.
- **Local runtime, public HTTPS endpoint.** The MCP service stays on loopback; use Tailscale Funnel or Cloudflare named tunnel for a stable public HTTPS `/mcp` endpoint instead of temporary tunnel URLs.

## What it includes

| Capability | Description |
| --- | --- |
| Repository registry | Register one or more Git checkouts and address them by stable `repoId` and `checkoutId`. |
| ChatGPT MCP controller | Repository inspection, Issues/Tasks, Direct Edit, verification, Git, GitHub sync, and execution tools. |
| Direct Edit transactions | Multi-revision patches, bounded paths and size, SHA preconditions, savepoints, diff review, checks, and rollback. |
| Issue → Task → Run workflow | Durable dependency-aware work planning with review and verification gates. |
| Local Controller UI | Local-only Overview, Work, Activity, and Settings views for Runs, edits, checks, and evidence. |
| Runtime control plane | Thin Gateway, Global Scheduler, per-repository Actor, durable Execution Jobs, Claims, Leases, fencing, and isolated Workers. |
| Automation governance | Bounded Schedule/Decision/Occurrence workflows, Candidate Findings, Portfolio DAG/Saga, and release gates. |
| Runtime isolation | Controller state is stored outside the public source tree and linked only where required at runtime. |
| Public release tooling | Allowlisted export, path and secret scanning, release-surface checks, and package verification. |

## Quick start

### 1. Prerequisites

- Git
- Bun 1.0 or newer
- macOS or Linux for the primary local workflow
- Recommended stable public endpoint: Tailscale CLI / macOS app, or your own domain with `cloudflared`

### 2. Run from source

```bash
git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
```

After the npm package is published, the installed command is:

```bash
bun add -g repo-harness
repo-harness install
repo-harness doctor
```

### 3. Adopt an existing repository

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
```

When running directly from this source checkout, replace `repo-harness` with:

```bash
bun run src/cli/index.ts
```

### 4. Register the repository

```bash
repo-harness repo register /path/to/your-project --name my-project --json
repo-harness repo list --json
```

Keep the returned `repoId`. It is the stable execution identity used by ChatGPT tools.

### 5. Start the ChatGPT Controller endpoint

Register the repository and generate the ChatGPT MCP config:

```bash
repo-harness repo register /path/to/your-project
repo-harness mcp setup chatgpt --repo /path/to/your-project
```

By default, MCP only listens on loopback:

```text
http://127.0.0.1:8765/mcp
```

ChatGPT needs a public HTTPS URL ending in `/mcp`. Recommended options:

1. **Tailscale Funnel**: no custom domain or DNS; best for personal long-running use.
2. **Cloudflare named tunnel + your own domain**: best for standard long-running deployments.
3. **ngrok / Cloudflare quick tunnel**: suitable for temporary testing, not long-running ChatGPT Project connectors.

Tailscale Funnel example:

```bash
# First-time setup
brew install --cask tailscale
tailscale up

# Publish local MCP through HTTPS Funnel
tailscale funnel --bg 8765
tailscale funnel status
```

If the output looks like this:

```text
https://your-machine.your-tailnet.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8765
```

use this ChatGPT Connector URL:

```text
https://your-machine.your-tailnet.ts.net/mcp
```

Then start repo-harness with the same endpoint:

```bash
repo-harness mcp keepalive --repo /path/to/your-project --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel tailscale \
  --public-endpoint https://your-machine.your-tailnet.ts.net/mcp
```

### 6. One-command local lifecycle on macOS

From the source checkout, use the unified lifecycle wrapper to start, stop, inspect, restart, and read logs for the detached Controller stack:

```bash
bun run controller:start
bun run controller:status
bun run controller:logs
bun run controller:restart
bun run controller:stop
```

The same workflow is available without `package.json` scripts:

```bash
bash scripts/controller-runtime.sh start --repo .
bash scripts/controller-runtime.sh status --repo .
```

`start` performs bounded preflight checks for Bun, repository root resolution, package version, tracked PID state, MCP and Local Controller ports, controller home, and detached repo-harness orphan processes before launching the daemon, MCP Gateway, and Local Bridge. Logs default to `.ai/local/logs/repo-harness-controller.log`.

`controller-runtime.sh` no longer starts the legacy ngrok rotation by default, which prevents old public endpoints from conflicting with the current Tailscale or Cloudflare endpoint. Enable the legacy ngrok rotation only when explicitly needed:

```bash
REPO_HARNESS_CONTROLLER_EXTERNAL_TUNNEL=ngrok scripts/controller-runtime.sh start
```

Stable public endpoints should be stored in the controllerHome-backed MCP service config; legacy `.repo-harness/mcp.local.json` is only a fallback.

## Connect ChatGPT

1. Make the MCP endpoint reachable over HTTPS, ending in `/mcp`; for personal long-running use, prefer Tailscale Funnel, for example `https://your-machine.your-tailnet.ts.net/mcp`.
2. In ChatGPT, enable developer mode in **Settings → Apps & Connectors → Advanced settings**.
3. Create a connector and enter the public MCP URL, for example `https://mcp.example.com/mcp`.
4. Start a new chat and add the connector from the composer tools menu.
5. Before allowing writes, test repository inspection and `project_snapshot` first.

This README is the public usage guide. Switch to [README.md](README.md) for Simplified Chinese.

## Make one repository the default in a ChatGPT Project

Yes. Put the stable repository identity in the ChatGPT Project instructions so every conversation in that Project starts with the same routing rule:

```text
Use repo-harness for repository work.
Default repoId: <repo-id returned by repo-harness repo register>
Default checkoutId: <checkout-id returned by repo-harness repo register>

Always pass this repoId and checkoutId to repo-harness tools unless I explicitly select another repository.
Start repository work with controller_capabilities and project_snapshot.
Prefer repository search plus Direct Edit for bounded changes. Do not start an Agent unless the work genuinely requires one.
```

Project instructions are a durable conversation default, not a server-side authorization boundary. The controller still requires an explicit `repoId` when multiple repositories are enabled. This is intentional protection against changing the wrong repository.

## Documentation policy

Public usage documentation is limited to:

- [English README](README.en.md)
- [简体中文 README](README.md)

The `docs/` directory remains for architecture notes, historical design records, operations notes, and internal references. It is not the normal user entry point.

## Security model

- Keep the MCP runtime bound to `127.0.0.1`; publish it only through a controlled HTTPS tunnel or reverse proxy.
- Do not expose the local Controller UI (`127.0.0.1:8766`) publicly.
- Prefer ChatGPT connector authentication and conservative app permissions for write-capable tools.
- Use named checks instead of arbitrary verification commands.
- Review diffs and verification evidence before accepting a Task or finalizing a Direct Edit.
- Never commit Controller runtime state, local logs, credentials, tokens, worktrees, or edit-session data.

## Upstream and license

This project is a substantially modified derivative of [AncientTwo/repo-harness](https://github.com/AncientTwo/repo-harness). The original project established the repo-local workflow foundation; this repository adds and adapts the ChatGPT Controller, repository registry, runtime-storage isolation, Direct Edit execution, governance, verification, local execution bridge, and public-release tooling.

Distributed under the MIT License. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Reference to the upstream project does not imply endorsement of this derivative work.

## Status

This repository is being prepared as an independently publishable open-source distribution. Before a release, run:

```bash
bun run check:release-surface
bun run check:public-export
bun run check:type
bun run check:runtime-architecture
bun run check:mcp-compatibility
bun run smoke:runtime-recovery
bun run smoke:schedule-engine
bun run smoke:runtime-control-plane
bun run smoke:mcp-http-runtime
bun run test
```
