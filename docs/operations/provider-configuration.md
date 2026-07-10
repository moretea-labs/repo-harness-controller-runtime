# Provider configuration and routing

repo-harness does not require or privilege a specific model vendor. A fresh installation builds neutral routing from provider kind, declared capabilities, health, and the configured provider priority. Providers with the same priority use the provider id only as a deterministic tie-breaker.

## Where configuration lives

The Controller GUI and the JSON files below edit the same controller-scoped configuration:

- `<controllerHome>/global/provider-config.json`: enable/disable providers, priority, model and non-secret API settings.
- `<controllerHome>/global/executor-routing.json`: explicit provider order for each task intent.
- `<controllerHome>/global/provider-secrets.json`: locally stored API credentials. This file is outside the repository and must never be committed.

Opening the GUI or reading configuration does not rewrite these files. Existing routing and priority choices remain authoritative across upgrades.

## Precedence

Provider selection applies these rules in order:

1. Per-request provider preferences and allow/deny constraints.
2. An explicit order or default in `executor-routing.json`, including changes made in the GUI routing editor.
3. Neutral generated defaults based on provider kind and `provider-config.json` priority.
4. Availability, enablement, authentication, live-call policy, safety gates, and required capabilities.
5. A ChatGPT handoff packet when no direct provider can safely run.

An explicit routing order intentionally overrides the general provider priority. The GUI shows both controls so users can decide whether task types follow a specific route or the general provider preference. Use **Use automatic routing** in the routing panel to remove explicit overrides and resume generated priority-based routing; do not delete the whole controller configuration.

## Personal preferences

Maintainers and users may place Grok, Codex, Claude, an API provider, or another registered provider first in their own Controller configuration. Those preferences belong under `controllerHome`; they are not open-source defaults and are not copied into the repository.

Remote API calls remain double-gated: the provider must be enabled/configured in the GUI and `REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS` must explicitly allow live calls. Without both, the API provider is proposal-only.
