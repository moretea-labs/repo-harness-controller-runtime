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

## DeepSeek backup controller mode

The first DeepSeek patch exposed a function-calling adapter: DeepSeek could return one of a few safe function calls and repo-harness could translate it into a policy-checked operation. That is useful, but it is not enough for a real fallback controller.

This update adds a backup-controller model:

- `deepseek-backup-controller` is a first-class model client.
- It can be activated for manual handoff, ChatGPT connector blockage fallback, ChatGPT unavailability, or parallel review.
- It receives a controller handoff packet and a bounded DeepSeek chat-completions request preview.
- It still cannot execute tools directly. repo-harness remains the policy, lease, approval, and audit authority.
- It receives only low-interception function tools and bounded intent/context. Raw repository contents, raw config files, browser profiles, secrets, cookies, and arbitrary shell commands are not included by default.

New tools:

- `model_control_plane_summary`: summarizes primary/backup controllers and the shared concurrency policy.
- `deepseek_controller_manifest`: returns the backup-controller role, boundaries, and safe function manifest.
- `deepseek_controller_handoff_prepare`: prepares a handoff packet when ChatGPT is blocked or the user manually chooses DeepSeek.
- `deepseek_controller_request_prepare`: prepares a DeepSeek chat-completions request payload without sending it.
- `work_status_digest`: neutral alias for redacted job/work outcome reading. Prefer it over `work_result_summary` when using ChatGPT because it avoids result/raw-output wording.

The intended flow is:

1. ChatGPT or the local GUI detects that ChatGPT tool execution is blocked or degraded.
2. The user chooses “handoff to DeepSeek backup controller”.
3. repo-harness creates a handoff packet with objective, reason, safe error context, and the safe function manifest.
4. A local DeepSeek client sends the prepared request using `DEEPSEEK_API_KEY` or `REPO_HARNESS_DEEPSEEK_API_KEY`.
5. DeepSeek returns one function call or a clarification question.
6. repo-harness maps the function call into its own operation and runs the normal policy/approval/lease/audit path.

This is intentionally not an encryption or bypass mechanism. DeepSeek is a second controller brain; repo-harness is still the only execution authority.
