# Features and Setup Levels

repo-harness is useful without coding agents or external plugins. Start with the core workflow, then add integrations only when a task requires them.

## Core features

These features are part of the default local setup:

- repository registration with stable `repoId` and `checkoutId` identities;
- bounded repository inspection and context collection;
- five preferred ChatGPT facade tools: `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work`, plus a stable repair-capable default MCP schema;
- Direct Edit sessions with path limits, SHA preconditions, revisions, savepoints, diffs, checks, and rollback;
- durable Issue → Task → Run state and resumable evidence;
- named verification checks instead of arbitrary remote shell access;
- local Controller UI and append-only activity/evidence records;
- runtime storage isolation under Controller Home;
- multi-repository routing and explicit target selection;
- release gates, tracked-file hygiene, and public export checks.

## Optional features

| Integration | What it adds | Requirement |
| --- | --- | --- |
| Codex / Claude | Delegated implementation for work too large for Direct Edit | Install and authenticate the corresponding CLI; explicitly enable the dev runner. |
| GitHub | Issue/Project synchronization, PR workflows, cloud-agent sessions | Authenticated `gh` and repository permission. |
| Tailscale / Cloudflare | Stable HTTPS endpoint for ChatGPT MCP | Tunnel client and appropriate account/domain configuration. |
| Browser | Playwright navigation, screenshots, and bounded browser evidence | Browser binaries and allowed domains. |
| CodeGraph | Additional code relationships and impact navigation | CodeGraph CLI; native Windows automatic setup is not yet enabled. |
| Google Workspace | Gmail and Calendar assistant actions | Explicit OAuth setup and plugin permission. |
| Schedules and findings | Supervised recurring checks and candidate findings | Controller daemon running; live actions remain policy-gated. |

## Tool exposure

The default `advanced` toolset exposes one stable, repair-capable schema capped at 128 tools. `core` is a compatibility alias for the same schema. `full` exposes every historical definition and should be reserved for legacy integrations or deep compatibility diagnosis. Five workflow facades sit above typed atomic tools and internal handlers; capability metadata groups the existing functions by domain. The current MCP transport does not dynamically load domain schemas, so grouping does not remove or hide the typed tools.

## Execution choices

- Use Direct Edit for small or well-bounded changes.
- Use durable Tasks when work must survive sessions, has dependencies, or needs formal review evidence.
- Delegate to an Agent only when investigation or implementation breadth justifies it.
- Use named checks to verify results before acceptance.

## Authorization boundaries

Reading and local bounded checks can be automatic. Repository mutations, destructive cleanup, external side effects, remote Git operations, GitHub changes, email actions, and publication remain explicitly policy-gated. Connecting ChatGPT does not grant unrestricted shell or filesystem access.
