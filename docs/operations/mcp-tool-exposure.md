# MCP tool exposure profiles

Controller MCP `tools/list` is profile-gated so ChatGPT (and similar hosts) see a small default surface.

## Profiles

| Toolset | CLI | Exposed tools |
| --- | --- | --- |
| **core** (default) | `--toolset core` | `rh_status`, `rh_inbox`, `rh_context`, `rh_work` plus repository bootstrap/selection: `repository_list`, `repository_get`, `repository_register`, `repository_latest_source_diagnose`, `repository_bootstrap_local_project` |
| **advanced** | `--toolset advanced` | Former supervised controller set (work, campaign, recovery, interactive git, plugins, low-interception web tools) |
| **full** | `--toolset full` | Compatibility mode: every legacy + runtime tool definition |

Configure via CLI flags, `REPO_HARNESS_MCP_TOOLSET`, or `toolset` in MCP local config. Invalid values are rejected; empty/default is `core`.

## Guidance

- Prefer the four `rh_*` facade tools for day-to-day ChatGPT control-plane work.
- Use `advanced` only when a session explicitly needs the larger supervised tool menu.
- Use `full` only for compatibility with older clients or deep diagnostics.
- Adding a product capability should route through facade/capability metadata first; do not grow the default `tools/list` without an explicit product decision.

## Related checks

```bash
bun test tests/cli/mcp-tool-exposure-profiles.test.ts
bun scripts/smoke-mcp-tool-surface.ts
bun run check:mcp-compatibility
bash scripts/check-release-readiness.sh
```
