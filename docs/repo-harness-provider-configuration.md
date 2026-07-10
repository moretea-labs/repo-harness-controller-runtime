# Provider & Executor Configuration

## Purpose

The **Model & Tool Providers** (Automation Settings) GUI lets users control:

- which LLM / API providers are enabled
- which local execution tools are enabled
- provider priority and fallback order
- whether live remote model API calls are preferred
- policy / approval thresholds

repo-harness remains the owner of apply, verify, policy, and finalization. Models only propose.

## ChatGPT handoff vs direct-invokable providers

| Kind | Examples | Direct dispatch? |
| --- | --- | --- |
| Local agent CLI | `codex_cli`, `grok_cli`, `claude_cli` | Yes when ready; **may edit files and run commands** |
| Remote API | `grok_api`, `openai_api`, `deepseek_api` | Yes when ready + live mode; **proposal-only** (harness applies) |
| Cloud agent | `github_copilot_cloud` | Yes when ready; may mutate worktree |
| Handoff-only | `chatgpt_handoff` | **Never** |

Agent CLIs are intentionally lightly restricted on local file mutation so tools like Grok/Codex/Claude can implement features normally. repo-harness still owns policy gates for external/destructive effects and verification closeout.

ChatGPT current conversation always shows:

- Type: Handoff-only  
- Direct dispatch: Not supported  
- Explanation: repo-harness can create continuation packets, but cannot automatically invoke this ChatGPT session.

There is no “enable direct dispatch” toggle for ChatGPT.

## Where config is stored

Under **controllerHome** (not the git repo):

```
<controllerHome>/global/provider-config.json
<controllerHome>/global/local-tool-config.json
<controllerHome>/global/executor-routing.json
<controllerHome>/global/goal-loop-policy.json
```

Persisted fields only:

- enabled / disabled
- priority
- capability preferences (non-secret)
- credential **env var names** (references)
- policy thresholds
- live preference + goal-loop enable flag

**Never stored:** API keys, tokens, cookies, private keys, raw env values.

## Grok CLI setup (`grok_cli`)

Local **Grok Build TUI** binary on PATH (typically `~/.local/bin/grok`):

```bash
# Ensure the grok CLI is installed and on PATH
which grok
grok --version
```

Then in GUI **模型与工具**:

1. Confirm **Grok CLI** card is Ready (or enable the local tool if disabled)
2. Prefer it in repair/implementation order if desired

`grok_cli` is a **local CLI** provider:

- Direct dispatch does **not** require `REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS`
- repo-harness still owns apply/verify of any proposed changes
- Distinct from `grok_api` (remote xAI HTTP API)

## Remote API setup (Grok / OpenAI / DeepSeek)

### GUI configuration (recommended)

In **模型与工具**, each remote API card supports:

| Field | Storage | Notes |
| --- | --- | --- |
| **Base URL** | `controllerHome/global/provider-config.json` | Non-secret, e.g. `https://api.x.ai/v1` |
| **Model** | same | Non-secret, e.g. `grok-3` |
| **API Key** | `controllerHome/global/provider-secrets.json` | **Never** in git repo; list APIs only return mask like `…abc1` |

API:

- `GET /api/console/providers/:id/api-settings`
- `POST /api/console/providers/:id/api-settings` body: `{ baseUrl, model, apiKey?, clearApiKey? }`

### Environment variable (still supported)

```bash
export XAI_API_KEY=...   # or REPO_HARNESS_XAI_API_KEY
export OPENAI_API_KEY=...
export DEEPSEEK_API_KEY=...
export REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1
```

Auth resolution order: **env key first**, then stored GUI key.

Direct dispatch still requires:

1. Credential present (env **or** stored)  
2. Live mode effective (env flag **and** GUI `preferLiveModelProviders`)

## OpenAI / DeepSeek setup

Same pattern:

```bash
export OPENAI_API_KEY=...
export DEEPSEEK_API_KEY=...
export REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1
```

Credential status UI lists required env var names and present/missing only — never values.

## Live provider global flag

- Env: `REPO_HARNESS_ENABLE_LIVE_MODEL_PROVIDERS=1`
- GUI preference: `preferLiveModelProviders` in `provider-config.json`
- Effective live = env **AND** preference

Offline / test structured proposals still work without live network when using mocks; production remote HTTP remains gated.

## Local tool enable/disable

Tools: `direct_edit`, `codex_cli`, `claude_cli`, `git`, `gh`, `bun`, `npm`, `xcodebuild`, `xcrun`, `simctl`, `playwright`, plugin-linked tools.

Disabled tools:

- show as disabled in GUI
- are not selected by ExecutorRouter (`direct_edit` / CLI providers map to disabled)

## Routing preferences

`executor-routing.json` orders intents:

- implementation, repair, planning, review, browser_planning, ios_analysis, deterministic_edit, fallback

Rules:

- Handoff-only may appear in fallback / planning lists
- Handoff-only is never treated as direct dispatch
- When no direct provider is ready: continuation packet instead of dispatch

## Safety policy settings

`goal-loop-policy.json` exposes approval requirements for external writes, destructive changes, broad refactors, browser form submit, Gmail send/trash, App Store Connect writes, final merge, and size thresholds.

There is **no** one-click “disable all safety”.

## Console APIs

| Endpoint | Role |
| --- | --- |
| `GET /api/console/automation-settings` | Full settings view model |
| `GET/POST /api/console/provider-config` | Provider prefs |
| `POST /api/console/providers/:id/enable|disable` | Toggle |
| `POST /api/console/providers/:id/priority` | Priority |
| `POST /api/console/providers/health` | Redacted health |
| `GET /api/console/providers/credentials` | Env presence only |
| `GET/POST local-tools` / `local-tool-config` | Local tools |
| `GET/POST /api/console/executor-routing` | Routing |
| `POST /api/console/executor-route-preview` | Preview |
| `GET/POST /api/console/goal-loop-policy` | Policy |

All responses are bounded and redacted.

## Related

- `docs/repo-harness-autonomous-goal-loop.md` — GoalContract loop design  
