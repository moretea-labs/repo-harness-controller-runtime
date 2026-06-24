# repo-harness Controller Runtime

<p align="center">
  <img src="docs/images/repo-harness-banner.svg" alt="repo-harness Controller Runtime — ChatGPT controls repository work through a local, reviewable execution bridge" width="1280">
</p>

<p align="center">
  <strong>ChatGPT as the controller. Your repository as the source of truth.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

`repo-harness Controller Runtime` is a local-first repository execution bridge for ChatGPT. It gives ChatGPT bounded tools to inspect repositories, manage Issues and Tasks, apply Direct Edits, run named checks, review diffs, and optionally delegate implementation to coding agents.

The project is designed for real repositories rather than disposable chat sessions: plans, task state, execution evidence, checks, and handoffs remain attached to the repository and can be resumed later.

> Current package version: `1.4.0`
>
> Controller tool surface: `controller-chatgpt-bridge-v8`, schema `10`, surface version `8`

## Why this project

- **ChatGPT controls the workflow.** ChatGPT reads, reasons, selects an execution mode, reviews changes, and decides what to do next.
- **Direct Edit first.** Small, known changes use bounded edit sessions with SHA protection, persisted diffs, savepoints, checks, and rollback.
- **Agents are optional workers.** Codex, Claude, or GitHub Copilot can be delegated larger implementation work, but they are not required for every change.
- **Repository state survives conversations.** Issues, Tasks, Runs, verification evidence, and handoffs are file-backed.
- **Multiple repositories are explicit.** Each registered repository receives a stable `repoId`; ambiguous multi-repository operations must name the target repository.
- **Local runtime, public HTTPS endpoint.** The MCP service stays on loopback and can be exposed through Cloudflare Tunnel or an external tunnel such as ngrok.

## What it includes

| Capability | Description |
| --- | --- |
| Repository registry | Register one or more Git checkouts and address them by stable `repoId` and `checkoutId`. |
| ChatGPT MCP controller | Repository inspection, Issues/Tasks, Direct Edit, verification, Git, GitHub sync, and execution tools. |
| Direct Edit transactions | Multi-revision patches, bounded paths and size, SHA preconditions, savepoints, diff review, checks, and rollback. |
| Issue → Task → Run workflow | Durable dependency-aware work planning with review and verification gates. |
| Local Controller UI | Local-only Overview, Work, Activity, and Settings views for Runs, edits, checks, and evidence. |
| Runtime isolation | Controller state is stored outside the public source tree and linked only where required at runtime. |
| Public release tooling | Allowlisted export, path and secret scanning, release-surface checks, and package verification. |

## Quick start

### 1. Prerequisites

- Git
- Bun 1.0 or newer
- macOS or Linux for the primary local workflow
- `cloudflared` only when using the built-in Cloudflare tunnel modes

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

For a temporary Cloudflare URL:

```bash
cd /path/to/your-project
repo-harness mcp setup chatgpt --repo .
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel quick
```

For a stable domain, use a named Cloudflare Tunnel. For ngrok, start the MCP server with `--tunnel none` and forward the local MCP port externally. Both procedures are documented in the complete guide.

## Connect ChatGPT

1. Make the MCP endpoint reachable over HTTPS, ending in `/mcp`.
2. In ChatGPT, enable developer mode in **Settings → Apps & Connectors → Advanced settings**.
3. Create a connector and enter the public MCP URL, for example `https://mcp.example.com/mcp`.
4. Start a new chat and add the connector from the composer tools menu.
5. Before allowing writes, test repository inspection and `project_snapshot` first.

See the [complete usage guide](docs/public-usage-guide.md#connect-chatgpt) for the current setup flow, permission recommendations, tunnel options, and troubleshooting.

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

## Documentation

- [Complete usage guide](docs/public-usage-guide.md)
- [完整使用指南（简体中文）](docs/public-usage-guide.zh-CN.md)
- [ChatGPT MCP setup reference](docs/repo-harness-chatgpt-mcp-setup.md)
- [ChatGPT Controller workflow](docs/repo-harness-chatgpt-controller.md)
- [Local execution bridge](docs/repo-harness-local-execution-bridge.md)
- [V8 Controller design](docs/repo-harness-chatgpt-bridge-v8.md)
- [Changelog](docs/CHANGELOG.md)

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
bun run test
```
