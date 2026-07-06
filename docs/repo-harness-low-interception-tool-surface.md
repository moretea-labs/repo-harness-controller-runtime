# repo-harness low-interception tool surface

This design avoids transport encryption or opaque payloads. The goal is to make model-to-controller calls easier to classify and safer to audit by replacing broad primitives with parameterized, redacted operations.

## Problem

The following calls are useful but high-friction in hosted model environments because they look like arbitrary browser control, shell/config probing, or raw job-log extraction:

- `browser.open_page(url)`
- `browser.configure({ allowed_domains: [...] })`
- raw config file reads
- shell commands such as `grep` to inspect config
- full job-result reads that may include paths, profile locations, or stdout/stderr

## Replacement surface

The new surface keeps old plugin actions for local compatibility but exposes safer MCP names for model clients:

| Old primitive | New tool | Safety improvement |
| --- | --- | --- |
| `browser.open_page(url)` | `web_target_snapshot(target_key, path, capture)` | No arbitrary URL. The model chooses a registered target key and a relative path only. |
| `browser.configure allowed_domains` | `web_domain_access_preview` then `web_domain_access_apply` | Domain-only preview, ticket, explicit authorization, no raw config output. |
| Read plugin config file | `toolchain_plugin_summary(plugin_id)` | Redacted health, permission, action, and risk counts only. |
| `grep` config | `toolchain_plugin_summary` / targeted summary tools | No shell probing needed for routine status. |
| Full job read | `work_result_summary(job_id)` | Redacted failure class and suggested next action; no raw stdout/stderr. |

## DeepSeek integration

DeepSeek is modeled as a function-calling client, not as a bypass. It receives a limited function manifest from `deepseek_tool_manifest`. Calls are translated by `deepseek_tool_call_prepare` into repo-harness operations and still require the normal repo-harness policy, approval, leases, and audit layers before execution.

Supported initial DeepSeek functions:

- `repo_harness_web_target_snapshot`
- `repo_harness_plugin_config_summary`
- `repo_harness_work_result_summary`

`model_clients_summary` reports whether `DEEPSEEK_API_KEY` or `REPO_HARNESS_DEEPSEEK_API_KEY` is configured. The adapter intentionally does not execute local work by itself.

## Safety rules

- No encrypted or opaque payloads are introduced.
- No arbitrary URL is accepted by the safe web snapshot tool.
- No raw plugin config, secrets, stdout, stderr, or absolute paths are returned by summary tools.
- Domain changes are split into preview and authorized apply.
- DeepSeek and ChatGPT share repo-harness as the single policy owner.
