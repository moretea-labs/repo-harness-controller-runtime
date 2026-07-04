# Controller Browser Plugin

The `browser` plugin gives the controller a local Playwright-backed browser surface for bounded page reading and explicitly authorized interaction.

## Scope

Supported actions:

- `configure`
- `open_page`
- `get_text`
- `screenshot`
- `click`
- `type`
- `press`
- `wait_for_selector`
- `close_page`

Out of scope by design:

- submit flows
- delete flows
- publish flows
- payment flows
- send flows
- download flows
- upload flows

Those higher-risk actions are intentionally absent from the manifest. The plugin is not a general browser automation escape hatch.

## Runtime model

- `plugin_id` stays `browser`
- the provider is a local Playwright persistent context
- profile data lives under `.repo-harness/browser/profiles/`
- saved sessions live under `.repo-harness/browser/sessions/`
- screenshots live under `.repo-harness/browser/screenshots/`

Each action launches the persistent context, restores the target URL, performs one bounded operation, persists the updated session metadata, then closes the context.

## Configuration

The source of truth is `.repo-harness/plugins/browser.json`.

Example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "defaultTimeoutMs": 30000,
  "allowedDomains": ["example.com", "docs.example.com"]
}
```

`allowedDomains` is the safety boundary. If it is empty, the plugin can target any HTTP(S) host. If it is set, the plugin accepts only exact hosts or subdomains of those entries.

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
