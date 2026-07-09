# Controller Browser Plugin

The `browser` plugin gives the controller a local Playwright-backed browser surface for bounded page reading and explicitly authorized interaction.

## Scope

Supported action groups:

- **Session lifecycle**: `create_session`, `list_sessions`, `close_session`, `clear_session`, `close_page`
- **Navigation**: `open_page`, `navigate`, `reload`, `go_back`, `wait_for_load_state`
- **DOM / extraction**: `get_text`, `get_html`, `query_selector`, `query_all`, `get_attribute`, `extract_links`, `extract_tables`, `extract_forms`, `snapshot_interactive`
- **Screenshots / artifacts**: `screenshot` (page, full-page, or element selector)
- **Forms / interaction** (authorized): `click`, `double_click`, `hover`, `focus`, `type`, `fill`, `select_option`, `check`, `uncheck`, `press`, `keyboard_shortcut`, `wait_for_selector`
- **Bounded file transfer** (authorized): `attach_local_file`, `await_file_transfer`
- **Diagnostics**: `get_console_errors`, `get_failed_requests`

Still out of scope by design:

- free-form submit / delete / publish / payment / send workflows as first-class actions
- auto-opening downloaded executables
- leaking cookies, tokens, or raw profile secrets in responses

Interactions that can mutate remote state still require `confirm_authorization=true`. Domain allowlists remain enforced for every navigation and interaction result.

## Runtime model

- `plugin_id` stays `browser`
- the provider is a local Playwright persistent context
- the default profile mode is `repo_local`, with profile data under `.repo-harness/browser/profiles/`
- `profileMode=custom` is explicit-only and uses the configured Chrome/Chromium profile path directly
- saved sessions live under `.repo-harness/browser/sessions/`
- screenshots live under `.repo-harness/browser/screenshots/`
- downloads live under `.repo-harness/browser/downloads/`

Each action launches a visible browser context, restores the target URL, performs one bounded operation, persists the updated session metadata, then closes the context. Session metadata is reusable across actions via `session_id`. Transient navigation failures can retry with `retries` (1–3).

### Reliability and safety notes

- Domain allowlist is checked before navigation and after interactive URL changes.
- Selector failures include repair hints (`repairHint`) when possible.
- Console errors and failed requests are captured per open cycle.
- Artifacts stay under `.repo-harness/browser/**` (not arbitrary local paths).
- Health `userFacingStatus` reports `ready`, `domain restricted`, `session active`, or setup states.

## Configuration

The source of truth is `.repo-harness/plugins/browser.json`.

Example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "profileMode": "repo_local",
  "browserChannel": "chromium",
  "defaultTimeoutMs": 30000,
  "allowedDomains": ["example.com", "docs.example.com"]
}
```

`allowedDomains` is the safety boundary. If it is empty, the plugin can target any HTTP(S) host. If it is set, the plugin accepts only exact hosts or subdomains of those entries.

Additional browser/profile fields:

- `profileMode`
  - `repo_local` keeps the plugin on the repo-owned Playwright profile under `.repo-harness/browser/profiles/default`.
  - `custom` is the explicit opt-in path for an existing Chrome/Chromium profile.
- `profileDir`
  - required when `profileMode=custom`
  - may point either at a browser user-data directory or at one profile subdirectory such as `Profile 1`
- `profileDirectory`
  - optional when `profileDir` points at the browser user-data directory
  - selects one Chrome profile inside that user-data directory
- `browserChannel`
  - `chromium` (default bundled Playwright engine)
  - `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`
- `executablePath`
  - explicit Chrome/Chromium binary path
  - mutually exclusive with `browserChannel`

For an existing signed-in Chrome profile, prefer `profileMode=custom` plus `browserChannel=chrome` or an explicit `executablePath`. The plugin does not attach to a real user profile unless that custom mode is configured on purpose.

Example custom Chrome binding:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "profileMode": "custom",
  "profileDir": "/Users/alice/Library/Application Support/Google/Chrome",
  "profileDirectory": "Profile 1",
  "browserChannel": "chrome",
  "defaultTimeoutMs": 30000,
  "allowedDomains": ["appstoreconnect.apple.com"]
}
```

If `profileMode=custom` points at a live personal Chrome profile, close that same Chrome/Chromium instance first when the browser reports profile-lock or profile-in-use errors.

## Policy surface

Readonly actions:

- `open_page`
- `get_text`
- `screenshot`
- `close_page`

These stay `confirmation=none` and `risk=readonly`.

Interactive actions:

- `click`
- `type`
- `press`
- `wait_for_selector`

These require `confirmation=authorization`.

Risk levels:

- `click`, `type`, `press` use `risk=remote_write`
- `wait_for_selector` uses `risk=workspace_write`

## Allowed-domain enforcement

The plugin enforces `allowedDomains` in three places:

1. It validates the explicit `url` before opening a page.
2. It validates any saved `session_id` target before interaction.
3. It re-checks the resulting page URL after the action and rejects the result if navigation leaves the allowed set.

The plugin does not intentionally provide any action that can bypass this boundary.

## Dependency requirement

The browser plugin requires the `playwright` package in the repo runtime.

If Playwright is missing:

- plugin health reports a dependency error
- action execution returns `PLUGIN_DEPENDENCY_MISSING`
- the expected remediation is `bun install`

## Interaction results

Successful `click`, `type`, `press`, and `wait_for_selector` responses include:

- the resolved `url`
- the page `title`
- an `action.summary`
- updated `session` metadata
- a best-effort screenshot path when capture succeeds

Example response shape:

```json
{
  "provider": "playwright",
  "url": "https://example.com/",
  "title": "Example",
  "action": {
    "actionId": "click",
    "summary": "Clicked #cta."
  },
  "session": {
    "sessionId": "browser_1234abcd",
    "url": "https://example.com/",
    "title": "Example"
  },
  "screenshot": {
    "path": ".repo-harness/browser/screenshots/..."
  }
}
```

## Usage notes

- Prefer `open_page` first when you need a stable `session_id`.
- `click`, `type`, `press`, and `wait_for_selector` accept either `session_id` or `url`.
- If both `session_id` and `url` are provided, they must resolve to the same page target.
- `close_page` only removes saved session metadata. It does not delete the persistent profile.
- `profile_dir` is rejected unless `profile_mode=custom` is already configured or supplied in the same `configure` call.
- Visible Chrome/Chromium launches are supported, but each action still closes after it completes. For longer human-driven login, MFA, or consent steps, stop, let the user complete the step in their own browser, then rerun the next bounded action or Task.
