# repo-harness Controller Runtime: Complete Usage Guide

[English](public-usage-guide.md) · [简体中文](public-usage-guide.zh-CN.md)

This guide covers the public installation and daily-use path for `repo-harness Controller Runtime` 1.4.0.

## 1. Mental model

```text
ChatGPT
  ↓ HTTPS MCP
repo-harness Controller (local machine)
  ├─ repository inspection
  ├─ Direct Edit transactions
  ├─ Issues / Tasks / Runs
  ├─ named verification checks
  └─ optional coding-agent workers
        ↓
registered Git repository
```

ChatGPT is the controller. repo-harness supplies bounded repository capabilities and persistent state. Coding agents are optional implementation workers, not the default owner of the workflow.

## 2. Requirements

Required:

- Git
- Bun 1.0 or newer
- a local Git repository to manage
- a ChatGPT account that can create developer-mode connectors

Optional:

- `cloudflared` for built-in quick or named Cloudflare Tunnel modes
- ngrok for an external temporary or reserved HTTPS endpoint
- Codex, Claude, or GitHub Copilot when agent delegation is enabled
- GitHub CLI for optional GitHub Issue and Project synchronization

## 3. Install

### 3.1 Source checkout

This path works before the npm release is published:

```bash
git clone https://github.com/greysonOuyang/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
```

For source-checkout commands in this guide, you may replace `repo-harness` with:

```bash
bun run /path/to/repo-harness-controller-runtime/src/cli/index.ts
```

### 3.2 Published package

After the package is published:

```bash
bun add -g repo-harness
repo-harness install
repo-harness doctor
```

`install` prepares the host-level runtime. It does not automatically adopt every repository on the machine.

## 4. Adopt an existing repository

Preview first:

```bash
repo-harness adopt --repo /path/to/project --dry-run
```

Apply:

```bash
repo-harness adopt --repo /path/to/project
```

Adoption writes or refreshes the repo-local workflow contract, including planning, task, context, hook, check, and handoff surfaces. Review the dry-run before applying it to a repository with custom files in the same paths.

## 5. Register repositories

Register a checkout:

```bash
repo-harness repo register /path/to/project --name my-project --json
```

Inspect the registry:

```bash
repo-harness repo list --json
repo-harness repo inspect <repo-id> --json
repo-harness repo validate <repo-id> --json
```

The returned values have different roles:

- `repoId`: stable repository identity shared by checkouts of the same canonical remote.
- `checkoutId`: identity of one local checkout.
- repository path: local location, which may change without changing the canonical repository identity.

When exactly one repository is enabled, the controller may select it automatically for compatible tools. When multiple repositories are enabled, `repoId` is required. Do not use `repo focus` as an execution security boundary; it is only an interactive UI preference.

## 6. Start the local Controller

Generate the ChatGPT setup material from the target repository:

```bash
cd /path/to/project
repo-harness mcp setup chatgpt --repo .
```

Start without a public tunnel:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel none
```

Default local endpoints:

- MCP HTTP server: `http://127.0.0.1:8765/mcp`
- local Controller UI: `http://127.0.0.1:8766/`

The local UI must remain private. Expose the MCP endpoint only.

## 7. Publish the MCP endpoint over HTTPS

ChatGPT must reach the MCP server over HTTPS. Choose one tunnel method.

### 7.1 Cloudflare quick tunnel

Best for a fast test with an ephemeral URL:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel quick
```

The command discovers the generated `trycloudflare.com` URL. Use the printed URL ending in `/mcp` as the ChatGPT connector URL.

Limitations:

- the hostname can change after restart;
- it is unsuitable as a durable Project connector;
- you may need to update or recreate the ChatGPT connector when the URL changes.

### 7.2 Cloudflare named tunnel with your domain

Recommended for a stable deployment when your domain is managed in Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create repo-harness-mcp
cloudflared tunnel route dns repo-harness-mcp mcp.example.com
```

Then start repo-harness with the named tunnel:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel named \
  --cloudflare-tunnel-name repo-harness-mcp \
  --public-endpoint https://mcp.example.com/mcp
```

Regenerate the ChatGPT setup with the stable endpoint when needed:

```bash
repo-harness mcp setup chatgpt --repo . \
  --endpoint https://mcp.example.com/mcp
```

Cloudflare documentation: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>

### 7.3 ngrok external tunnel

The requested “grok reverse proxy” is documented here as **ngrok**, the tunnel product. ngrok is not an embedded repo-harness tunnel mode, so run it separately.

Terminal A:

```bash
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude \
  --tunnel none
```

Terminal B:

```bash
ngrok http 8765
```

If ngrok prints `https://example.ngrok.app`, the ChatGPT connector URL is:

```text
https://example.ngrok.app/mcp
```

Persist that endpoint into the generated setup material:

```bash
repo-harness mcp setup chatgpt --repo . \
  --endpoint https://example.ngrok.app/mcp
```

Free temporary domains can change. Use an ngrok reserved/static domain or Cloudflare named tunnel for a durable connector.

ngrok documentation: <https://ngrok.com/docs/getting-started/>

### 7.4 Reverse-proxy rules

For any other HTTPS reverse proxy:

- forward `/mcp` to `http://127.0.0.1:8765/mcp`;
- forward `/health` only when required for monitoring;
- preserve streaming and long-lived HTTP responses;
- do not publish port `8766` or the local Controller UI;
- add authentication and access restrictions appropriate to a write-capable tool server;
- do not place secrets in query parameters or public documentation.

## 8. Connect ChatGPT

The current OpenAI developer flow is:

1. Open ChatGPT settings.
2. Go to **Apps & Connectors → Advanced settings** and enable developer mode.
3. Go to **Connectors** and choose **Create**.
4. Enter a user-facing name and a clear description.
5. Set the Connector URL to the public HTTPS `/mcp` endpoint.
6. Create the connector and verify the advertised tool list.
7. Start a new chat, open the composer tools menu, and add the connector.

OpenAI reference: <https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>

Recommended first test:

```text
Call controller_capabilities and project_snapshot for my default repoId. Do not change files.
```

Recommended initial permissions:

- use **Always ask** while validating the deployment; or
- use **Ask before making changes** after read-only inspection is trusted.

Refresh the connector metadata in ChatGPT after upgrading the controller tool surface or changing tool descriptions.

## 9. Make a repository default in a ChatGPT Project

A ChatGPT Project can keep the repository identity and workflow rules in Project instructions. This removes the need to repeat them in every conversation.

Use a template like this:

```text
Use repo-harness for all repository work in this Project.

Default repository:
- repoId: <repo-id returned by repo-harness repo register>
- checkoutId: <checkout-id returned by repo-harness repo register>

Rules:
1. Pass the repoId and checkoutId to every repository-scoped repo-harness tool unless I explicitly select another repository.
2. Start with controller_capabilities, project_snapshot, get_project_governance, list_edit_sessions, and list_checks when governance context is needed.
3. Prefer search_repository/read_repository_file plus bounded Direct Edit for known changes.
4. Do not launch Codex, Claude, or Copilot unless the task is too broad or uncertain for Direct Edit, or I explicitly request an Agent.
5. Never push, merge, delete branches, rewrite history, or perform another destructive operation without explicit authorization in the current request.
6. Treat existing working-tree changes as user work and preserve them unless I explicitly ask to replace them.
```

Important limitations:

- Project instructions guide ChatGPT; they do not change server-side authorization.
- The connector still has to be available to the conversation.
- A multi-repository controller should continue passing `repoId` explicitly.
- `repo focus` does not replace explicit repository routing.

## 10. Daily workflows

### Read-only repository review

```text
Use repo-harness with the default repoId. Read controller_capabilities and project_snapshot, inspect Git status and relevant files, then report findings. Do not modify anything.
```

### Small bounded change

```text
Inspect the relevant files, assess the work request, and use Direct Edit if the scope is known and bounded. Show the persisted diff, run named checks, and finalize only after verification passes.
```

### Large governed change

```text
Inspect the repository and current Issue. Split the work into dependency-aware Tasks. Do not start Agents until the plan and path boundaries are reviewable.
```

### Continue an existing Issue

```text
Read project_snapshot, get_project_governance, the current Issue, recent edit sessions, and checks. Continue the lowest-risk ready work without restarting completed or cancelled Agents unless retry is explicitly needed.
```

## 11. Core commands

| Command | Purpose |
| --- | --- |
| `repo-harness doctor` | Read-only host and installation diagnostics. |
| `repo-harness install` | Prepare host-level runtime and adapters. |
| `repo-harness adopt --repo <path>` | Install or refresh repo-local workflow files. |
| `repo-harness repo register <path>` | Register a repository and return its stable identity. |
| `repo-harness repo list` | List registered repositories and current UI focus. |
| `repo-harness repo validate <repoId>` | Validate identity, checkout, runtime storage, and migration state. |
| `repo-harness mcp setup chatgpt --repo <path>` | Generate ChatGPT connector setup material. |
| `repo-harness mcp keepalive ...` | Supervise the MCP server, local UI, and optional Cloudflare tunnel. |
| `repo-harness repo rollout ...` | Refresh registered repositories and restart configured controllers. |

## 12. Security checklist

Before publishing an endpoint:

- [ ] MCP binds to `127.0.0.1`.
- [ ] only the MCP endpoint is exposed publicly.
- [ ] the local UI is not public.
- [ ] tokens and credentials are not stored in URLs, README examples, logs, or Git history.
- [ ] ChatGPT connector permissions require confirmation for changes.
- [ ] repository write paths are bounded.
- [ ] named checks are configured and pass.
- [ ] runtime directories, logs, worktrees, edit sessions, and controller state are ignored and untracked.
- [ ] `bun run check:release-surface` and `bun run check:public-export` pass before release.

## 13. Troubleshooting

### ChatGPT cannot connect

- confirm the URL is HTTPS and ends in `/mcp`;
- verify the tunnel is still running;
- test the local health endpoint first;
- check that the reverse proxy supports streaming responses;
- refresh connector metadata after server changes.

### Repository is ambiguous

Multiple repositories are enabled. Pass the intended `repoId` explicitly or disable repositories that should not be executable.

### The Project still asks which repository to use

Confirm the Project instructions contain the exact `repoId`, and state that every repo-harness call must pass it. Project instructions are guidance, so the assistant should still verify routing before a write.

### Quick tunnel URL changed

Update the ChatGPT connector URL or move to a named Cloudflare Tunnel, an ngrok reserved domain, or another stable HTTPS proxy.

### Tools look stale

Call `controller_capabilities`. If the tool surface version or fingerprint differs from the connector snapshot, refresh the ChatGPT connector metadata or recreate the connector.

## 14. Upstream and license

This distribution is derived from [AncientTwo/repo-harness](https://github.com/AncientTwo/repo-harness) and includes substantial Controller Runtime modifications. See [`NOTICE`](../NOTICE) and [`LICENSE`](../LICENSE) for attribution and MIT terms.
